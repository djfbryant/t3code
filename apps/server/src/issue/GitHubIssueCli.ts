import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  PositiveInt,
  TrimmedNonEmptyString,
  type IssueComment,
  type IssueListState,
  type IssueState,
  type PullRequestActor,
} from "@t3tools/contracts";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";

/** An issue row as GitHub's REST API reports it, before the service attaches project context. */
export interface GitHubIssueRow {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: PullRequestActor | null;
  readonly state: IssueState;
  readonly labels: ReadonlyArray<{ readonly name: string; readonly color: string | null }>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly commentCount: number;
}

export interface GitHubIssueDetail extends GitHubIssueRow {
  readonly body: string;
  readonly comments: ReadonlyArray<IssueComment>;
  readonly commentsTruncated: boolean;
}

/** `gh` could not run the read, or the answer was not the shape the host promises. */
export class GitHubIssueReadError extends Schema.TaggedError<GitHubIssueReadError>()(
  "GitHubIssueReadError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `GitHub issue read failed in ${this.operation}: ${this.detail}`;
  }
}

// The REST API's own keys, read as it writes them: `gh api` passes the body through
// unchanged, so the shapes here are GitHub's snake_case, not the GraphQL camelCase the
// change-request CLI reads.
const RawActor = Schema.Struct({
  login: TrimmedNonEmptyString,
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
});
const RawLabel = Schema.Struct({
  name: TrimmedNonEmptyString,
  color: Schema.optional(Schema.NullOr(Schema.String)),
});
const RawIssueComment = Schema.Struct({
  id: Schema.Number,
  body: Schema.String,
  created_at: IsoDateTime,
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Schema.NullOr(RawActor)),
});
const RawIssue = Schema.Struct({
  number: PositiveInt,
  title: Schema.NullOr(Schema.String),
  html_url: TrimmedNonEmptyString,
  state: Schema.Literals(["open", "closed"]),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  comments: Schema.optional(Schema.Number),
  user: Schema.optional(Schema.NullOr(RawActor)),
  labels: Schema.optional(Schema.Array(RawLabel)),
  // The host files change requests through this endpoint too; their marker is how the
  // listing drops them without a second request.
  pull_request: Schema.optionalKey(Schema.Struct({})),
});

const RawIssueList = Schema.Array(RawIssue);
const RawIssueCommentList = Schema.Array(RawIssueComment);

function actorOf(
  user: Schema.Schema.Type<typeof RawActor> | null | undefined,
): PullRequestActor | null {
  return user === null || user === undefined
    ? null
    : { login: user.login, name: null, avatarUrl: user.avatar_url ?? null };
}

function rowOf(raw: Schema.Schema.Type<typeof RawIssue>): GitHubIssueRow {
  return {
    number: raw.number,
    // GitHub can report a null title in pathological cases; the page needs a string.
    title: raw.title ?? "",
    url: raw.html_url,
    author: actorOf(raw.user),
    state: raw.state,
    labels: (raw.labels ?? []).map((label) => ({ name: label.name, color: label.color ?? null })),
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    commentCount: raw.comments ?? 0,
  };
}

/** A repository name that cannot be addressed as itself is refused rather than escaped. */
export function parseIssueRepositorySelector(repository: string): {
  readonly owner: string;
  readonly name: string;
} {
  const match = /^([^/]+)\/([^/]+)$/.exec(repository.trim());
  const owner = match?.[1];
  const name = match?.[2];
  if (owner === undefined || name === undefined || owner.length === 0 || name.length === 0) {
    throw new Error(`Repository '${repository}' cannot be addressed on GitHub.`);
  }
  return { owner, name };
}

export class GitHubIssueCli extends Context.Service<
  GitHubIssueCli,
  {
    /**
     * One page of a repository's issues, newest first, plus whether more follow. Change
     * requests arrive in this endpoint's answer and are dropped here rather than at the page,
     * because the tracker never shows them.
     */
    readonly list: (input: {
      readonly cwd: string;
      readonly host: string;
      readonly repository: string;
      readonly state: IssueListState;
      readonly perPage: number;
      /** Where the last answer stopped, as one of this CLI's own cursors. Absent is page one. */
      readonly cursor?: string | undefined;
    }) => Effect.Effect<
      { readonly rows: ReadonlyArray<GitHubIssueRow>; readonly truncated: boolean },
      GitHubIssueReadError
    >;

    /** The issue and its conversation, read whole up to the comment page bound. */
    readonly detail: (input: {
      readonly cwd: string;
      readonly host: string;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<GitHubIssueDetail, GitHubIssueReadError>;
  }
>()("t3/issue/GitHubIssueCli") {}

const COMMENTS_PER_PAGE = 100;

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const github = yield* GitHubCli.GitHubCli;

  // One `gh api` read: the subprocess, then the caller's own decode of the stdout it got.
  // The decode stays at the call site because each answer is a different shape, and a
  // schema passed through a helper loses the concrete codec type this Effect version needs.
  const ghApi = (input: {
    readonly cwd: string;
    readonly host: string;
    readonly endpoint: string;
    readonly fields: ReadonlyArray<readonly [string, string]>;
  }) =>
    github
      .execute({
        cwd: input.cwd,
        args: [
          "api",
          // Fields passed without an explicit method make `gh api` default to POST —
          // which would create an issue rather than read one. GET keeps `-f` as query
          // parameters, where this API expects them.
          "-X",
          "GET",
          "--hostname",
          input.host,
          input.endpoint,
          ...input.fields.flatMap(([key, value]) => ["-f", `${key}=${value}`]),
        ],
      })
      .pipe(
        Effect.mapError(
          (cause): GitHubIssueReadError =>
            new GitHubIssueReadError({
              operation: "run gh api",
              detail: "The GitHub CLI could not run the request.",
              cause,
            }),
        ),
        Effect.map((response) => response.stdout),
      );

  // Each answer is decoded by a schema the call site owns, so the codec stays concrete
  // and no `unknown` service leaks into the read's requirements.
  const decodeJson =
    (operation: string) =>
    <A>(decode: (stdout: string) => Effect.Effect<A, Schema.SchemaError>) =>
    (stdout: string): Effect.Effect<A, GitHubIssueReadError> =>
      decode(stdout).pipe(
        Effect.mapError(
          (cause): GitHubIssueReadError =>
            new GitHubIssueReadError({
              operation,
              detail: "The GitHub CLI response did not match the expected shape.",
              cause,
            }),
        ),
      );

  const list: GitHubIssueCli["Service"]["list"] = (input) => {
    const { owner, name } = parseIssueRepositorySelector(input.repository);
    const cursorPage = input.cursor === undefined ? undefined : Number.parseInt(input.cursor, 10);
    const page =
      cursorPage === undefined || !Number.isFinite(cursorPage) || cursorPage < 1 ? 1 : cursorPage;
    // One row over the page size is what tells the caller whether to offer a next page.
    return ghApi({
      cwd: input.cwd,
      host: input.host,
      endpoint: `repos/${owner}/${name}/issues`,
      fields: [
        ["state", input.state],
        ["sort", "created"],
        ["direction", "desc"],
        ["per_page", String(input.perPage + 1)],
        ["page", String(page)],
      ],
    }).pipe(
      Effect.flatMap(decodeJson("list")(Schema.decodeEffect(Schema.fromJsonString(RawIssueList)))),
      Effect.map((raw) => {
        const issues = raw.filter((issue) => issue.pull_request === undefined);
        return {
          rows: issues.slice(0, input.perPage).map(rowOf),
          truncated: issues.length > input.perPage,
        };
      }),
    );
  };

  const detail: GitHubIssueCli["Service"]["detail"] = (input) => {
    const { owner, name } = parseIssueRepositorySelector(input.repository);
    const issueRead = ghApi({
      cwd: input.cwd,
      host: input.host,
      endpoint: `repos/${owner}/${name}/issues/${input.number}`,
      fields: [],
    }).pipe(
      Effect.flatMap(decodeJson("detail")(Schema.decodeEffect(Schema.fromJsonString(RawIssue)))),
    );
    const commentsRead = ghApi({
      cwd: input.cwd,
      host: input.host,
      endpoint: `repos/${owner}/${name}/issues/${input.number}/comments`,
      fields: [["per_page", String(COMMENTS_PER_PAGE)]],
    }).pipe(
      Effect.flatMap(
        decodeJson("detail-comments")(
          Schema.decodeEffect(Schema.fromJsonString(RawIssueCommentList)),
        ),
      ),
    );
    return Effect.all([issueRead, commentsRead], { concurrency: 2 }).pipe(
      Effect.map(([rawIssue, rawComments]) => {
        const row = rowOf(rawIssue);
        return {
          ...row,
          body: rawIssue.body ?? "",
          comments: rawComments.slice(0, COMMENTS_PER_PAGE).map((comment) => ({
            id: String(comment.id),
            author: actorOf(comment.user),
            body: comment.body,
            createdAt: comment.created_at,
            url: comment.html_url ?? null,
          })),
          commentsTruncated: row.commentCount > rawComments.length,
        };
      }),
    );
  };

  return GitHubIssueCli.of({ list, detail });
});

export const layer = Layer.effect(GitHubIssueCli, make);
