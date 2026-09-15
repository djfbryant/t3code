import { describe, expect, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitHubIssueCli from "./GitHubIssueCli.ts";

const runWithResponses = (responses: readonly unknown[]) => {
  const calls: Array<ReadonlyArray<string>> = [];
  const execute: GitHubCli.GitHubCli["Service"]["execute"] = (request) =>
    Effect.sync(() => {
      calls.push(request.args);
      const value = responses[calls.length - 1];
      if (value === undefined) throw new Error("Unexpected GitHub request");
      return {
        exitCode: ChildProcessSpawner.ExitCode(0),
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        stdout: JSON.stringify(value),
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
      };
    });
  const cli = Effect.provide(GitHubIssueCli.make, Layer.mock(GitHubCli.GitHubCli)({ execute }));
  return { cli, calls };
};

// GitHub's REST shapes, read as `gh api` passes them through: snake_case keys, change
// requests riding along in the issues listing with their marker attached.
const issueJson = (overrides: Record<string, unknown> = {}) => ({
  number: 12,
  title: "Sidebar flickers",
  html_url: "https://github.com/acme/web/issues/12",
  state: "open",
  created_at: "2026-01-02T03:04:05Z",
  updated_at: "2026-01-03T03:04:05Z",
  comments: 2,
  user: { login: "octocat", avatar_url: "https://github.com/octocat.png" },
  labels: [{ name: "bug", color: "d73a4a" }],
  ...overrides,
});

const changeRequestJson = () => ({
  number: 11,
  title: "Add sidebar",
  html_url: "https://github.com/acme/web/pull/11",
  state: "open",
  created_at: "2026-01-01T03:04:05Z",
  updated_at: "2026-01-02T03:04:05Z",
  user: { login: "octocat" },
  pull_request: { html_url: "https://github.com/acme/web/pull/11" },
});

describe("GitHubIssueCli", () => {
  it.effect("lists issues without the change requests the endpoint rides along", () =>
    Effect.gen(function* () {
      const api = runWithResponses([
        [
          changeRequestJson(),
          issueJson(),
          {
            number: 13,
            title: "No author",
            html_url: "https://github.com/acme/web/issues/13",
            state: "closed",
            created_at: "2026-01-04T03:04:05Z",
            updated_at: "2026-01-04T03:04:05Z",
          },
        ],
      ]);
      const answer = yield* api.cli.pipe(
        Effect.flatMap((cli) =>
          cli.list({
            cwd: "/w",
            host: "github.com",
            repository: "acme/web",
            state: "all",
            perPage: 30,
            page: 1,
          }),
        ),
      );

      expect(answer.rows.map((row) => row.number)).toEqual([12, 13]);
      expect(answer.truncated).toBe(false);
      expect(answer.nextPage).toBeNull();
      // The author of the second row reports no avatar; the row carries null, not a guess.
      expect(answer.rows[1]?.author).toBeNull();
      expect(answer.rows[0]?.labels).toEqual([{ name: "bug", color: "d73a4a" }]);
      // The host is named explicitly, so an Enterprise install never resolves to github.com,
      // and the method is pinned to GET so the fields stay query parameters.
      expect(api.calls[0]?.slice(0, 6)).toEqual([
        "api",
        "-X",
        "GET",
        "--hostname",
        "github.com",
        "repos/acme/web/issues",
      ]);
    }),
  );

  it.effect("reads one row past the page to know whether more follow", () =>
    Effect.gen(function* () {
      const rows = Array.from({ length: 31 }, (_, index) => issueJson({ number: index + 1 }));
      const api = runWithResponses([rows]);
      const answer = yield* api.cli.pipe(
        Effect.flatMap((cli) =>
          cli.list({
            cwd: "/w",
            host: "github.com",
            repository: "acme/web",
            state: "open",
            perPage: 30,
            page: 2,
          }),
        ),
      );

      expect(answer.rows).toHaveLength(30);
      expect(answer.truncated).toBe(true);
      expect(answer.nextPage).toBe(3);
      expect(answer.rows[0]?.number).toBe(1);
      expect(api.calls[0]?.join(" ")).toContain("-f page=2");
      expect(api.calls[0]?.join(" ")).toContain("-f per_page=31");
    }),
  );

  it.effect("keeps reading past change-request rows so the page is not short", () =>
    Effect.gen(function* () {
      // The first REST page loses its issue rows to change requests — 30 of them plus one
      // issue — so the walk reads the next page rather than answering short and silently
      // hiding what follows.
      const firstPage = [
        ...Array.from({ length: 30 }, () => changeRequestJson()),
        issueJson({ number: 1 }),
      ];
      const secondPage = Array.from({ length: 31 }, (_, index) =>
        issueJson({ number: index + 100 }),
      );
      const api = runWithResponses([firstPage, secondPage]);
      const answer = yield* api.cli.pipe(
        Effect.flatMap((cli) =>
          cli.list({
            cwd: "/w",
            host: "github.com",
            repository: "acme/web",
            state: "open",
            perPage: 30,
            page: 1,
          }),
        ),
      );

      expect(answer.truncated).toBe(true);
      expect(answer.rows).toHaveLength(30);
      expect(answer.nextPage).toBe(3);
      // The walk read two REST pages: the first, and the one that proved there was more.
      expect(api.calls).toHaveLength(2);
      expect(api.calls[1]?.join(" ")).toContain("-f page=2");
    }),
  );

  it.effect("assembles the detail with its conversation and the shortfall it could not read", () =>
    Effect.gen(function* () {
      const api = runWithResponses([
        issueJson({ body: "Steps to reproduce…", comments: 3, state: "closed" }),
        [
          {
            id: 501,
            body: "Reproduced on arm64.",
            created_at: "2026-01-05T03:04:05Z",
            html_url: "https://github.com/acme/web/issues/12#issuecomment-501",
            user: { login: "ghost" },
          },
        ],
      ]);
      const read = yield* api.cli.pipe(
        Effect.flatMap((cli) =>
          cli.detail({
            cwd: "/w",
            host: "github.com",
            repository: "acme/web",
            number: 12,
          }),
        ),
      );

      expect(read.body).toBe("Steps to reproduce…");
      expect(read.commentCount).toBe(3);
      expect(read.comments).toHaveLength(1);
      expect(read.comments[0]?.author?.login).toBe("ghost");
      expect(read.commentsTruncated).toBe(true);
      expect(api.calls[1]?.join(" ")).toContain("issues/12/comments");
    }),
  );

  it.effect("refuses a repository name it cannot address", () =>
    Effect.sync(() => {
      expect(GitHubIssueCli.parseIssueRepositorySelector("acme")).toBeNull();
      expect(GitHubIssueCli.parseIssueRepositorySelector("acme/web/extra")).toBeNull();
      expect(GitHubIssueCli.parseIssueRepositorySelector("acme/web")).toEqual({
        owner: "acme",
        name: "web",
      });
    }),
  );
});
