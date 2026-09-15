import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  IssueOperationError,
  IssueUnavailableError,
  pullRequestHostOf,
  type IssueDetail,
  type IssueListInput,
  type IssueListResult,
  type IssueRef,
  type OrchestrationProjectShell,
  type ProjectId,
  type SourceControlProviderKind,
} from "@t3tools/contracts";
import {
  detectSourceControlProviderFromRemoteUrl,
  isSshRemoteUrl,
  sourceControlRepositorySelector,
} from "@t3tools/shared/sourceControl";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GitHubIssueCli from "./GitHubIssueCli.ts";

export type IssueError = IssueUnavailableError | IssueOperationError;

/**
 * Every read leaves the machine — a `gh` subprocess against a host whose limits are low — so
 * answers are shared for a short while, near the clients' own stale times. Reads that must not
 * share — the refresh button — go through `invalidate` rather than a flag on the read.
 */
const LIST_CACHE_TTL = Duration.seconds(30);
const DETAIL_CACHE_TTL = Duration.seconds(15);
const LIST_CACHE_CAPACITY = 32;
const DETAIL_CACHE_CAPACITY = 128;

/** Rows the listing asks the host for when the client does not name a size. */
const DEFAULT_LIST_LIMIT = 30;

/** The one checkout and host an issue read runs against. */
interface IssueTarget {
  readonly project: OrchestrationProjectShell;
  readonly host: string;
  readonly repository: string;
}

export class IssueService extends Context.Service<
  IssueService,
  {
    readonly list: (input: IssueListInput) => Effect.Effect<IssueListResult, IssueError>;
    readonly detail: (input: IssueRef) => Effect.Effect<IssueDetail, IssueError>;
    /** Forget the cached listings and details, so the next read asks the host again. */
    readonly invalidate: Effect.Effect<void>;
  }
>()("t3/issue/IssueService") {}

export const make = Effect.gen(function* () {
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const github = yield* GitHubIssueCli.GitHubIssueCli;

  const listCache = yield* Cache.makeWith(
    (key: string) => {
      // The parse undoes this module's own serialization, so the shapes are known exactly.
      const [projectId, state, limit, cursor] = JSON.parse(key) as [
        string,
        IssueListInput["state"],
        number | null,
        string | null,
      ];
      return listUncached({
        projectId,
        state,
        ...(limit === null ? {} : { limit }),
        ...(cursor === null ? {} : { cursor }),
      } as IssueListInput);
    },
    {
      capacity: LIST_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? LIST_CACHE_TTL : Duration.zero),
    },
  );
  const detailCache = yield* Cache.makeWith(
    (key: string) => {
      const [projectId, number] = key.split("#") as [string, string];
      return detailUncached({
        projectId,
        number: Number.parseInt(number, 10),
      } as IssueRef);
    },
    {
      capacity: DETAIL_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? DETAIL_CACHE_TTL : Duration.zero),
    },
  );

  const operationError = (operation: string, detail: string, cause?: unknown) =>
    new IssueOperationError({
      operation,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  /**
   * The project's own repository is the one the tracker reads. Its remote names the provider,
   * and only GitHub is implemented today — anything else is explained, not guessed at.
   */
  const resolveTarget = (input: {
    readonly projectId: ProjectId;
  }): Effect.Effect<IssueTarget, IssueError> =>
    Effect.gen(function* () {
      const project = yield* projections
        .getProjectShellById(input.projectId)
        .pipe(
          Effect.mapError((cause) =>
            operationError("resolveProject", "The project could not be read.", cause),
          ),
        );
      if (Option.isNone(project)) {
        return yield* operationError("resolveProject", "The project no longer exists.");
      }
      const shell = project.value;
      const identity = shell.repositoryIdentity;
      if (identity === null || identity === undefined) {
        return yield* new IssueUnavailableError({ reason: "provider-unsupported" });
      }
      let kind: SourceControlProviderKind | undefined = identity.provider as
        | SourceControlProviderKind
        | undefined;
      if (kind === undefined || kind === "unknown" || isSshRemoteUrl(identity.locator.remoteUrl)) {
        kind = detectSourceControlProviderFromRemoteUrl(identity.locator.remoteUrl)?.kind ?? kind;
      }
      const repository = sourceControlRepositorySelector(identity);
      if (repository === null) {
        return yield* operationError(
          "resolveRepository",
          "The project's repository could not be identified.",
        );
      }
      if (kind !== "github") {
        return yield* new IssueUnavailableError({ reason: "provider-unsupported" });
      }
      // `gh` is told the host explicitly, so the same `owner/repo` on an Enterprise install
      // never resolves to a same-named repository on github.com.
      return { project: shell, host: pullRequestHostOf(identity, "github"), repository };
    });

  // The cursor is this service's own encoding: the GitHub REST page to carry on from.
  // Both directions live here so no other module parses or fabricates one.
  const cursorToPage = (cursor: string | undefined): number => {
    const page = cursor === undefined ? NaN : Number.parseInt(cursor, 10);
    return Number.isFinite(page) && page >= 1 ? page : 1;
  };
  const pageToCursor = (page: number): string => String(page);

  const listUncached = (input: IssueListInput): Effect.Effect<IssueListResult, IssueError> =>
    Effect.gen(function* () {
      const target = yield* resolveTarget(input);
      const limit = input.limit ?? DEFAULT_LIST_LIMIT;
      const rows = yield* github
        .list({
          cwd: target.project.workspaceRoot,
          host: target.host,
          repository: target.repository,
          state: input.state,
          perPage: limit,
          page: cursorToPage(input.cursor),
        })
        .pipe(Effect.mapError(toIssueError(target)));
      return {
        entries: rows.rows.map((row) => ({
          ...row,
          projectId: target.project.id,
          projectTitle: target.project.title,
          host: target.host,
          repository: target.repository,
        })),
        truncated: rows.truncated,
        nextCursor: rows.nextPage === null ? null : pageToCursor(rows.nextPage),
      };
    });

  const detailUncached = (input: IssueRef): Effect.Effect<IssueDetail, IssueError> =>
    Effect.gen(function* () {
      const target = yield* resolveTarget(input);
      const detail = yield* github
        .detail({
          cwd: target.project.workspaceRoot,
          host: target.host,
          repository: target.repository,
          number: input.number,
        })
        .pipe(Effect.mapError(toIssueError(target)));
      return {
        ...detail,
        projectId: target.project.id,
        projectTitle: target.project.title,
        workspaceRoot: target.project.workspaceRoot,
        host: target.host,
        repository: target.repository,
      };
    });

  // GitHub's CLI failures are shaped to say which part broke; the unavailable reasons are
  // what the page turns into a fix-it sentence, so the mapping happens once, here.
  const toIssueError =
    (target: IssueTarget) =>
    (error: GitHubIssueCli.GitHubIssueReadError): IssueError => {
      const cause = error.cause;
      const detail = error.detail;
      const tag =
        typeof cause === "object" && cause !== null && "_tag" in cause
          ? (cause as { _tag: string })._tag
          : "";
      if (tag === "GitHubCliUnavailableError") {
        return new IssueUnavailableError({
          reason: "cli-missing",
          cause: detail ? new Error(detail) : undefined,
        });
      }
      if (tag === "GitHubCliAuthenticationError") {
        return new IssueUnavailableError({
          reason: "cli-unauthenticated",
          cause: detail ? new Error(detail) : undefined,
        });
      }
      if (tag === "GitHubCliRateLimitError") {
        return new IssueUnavailableError({
          reason: "rate-limited",
          cause: detail ? new Error(detail) : undefined,
        });
      }
      return new IssueOperationError({
        operation: `issues ${target.host}/${target.repository}`,
        detail,
        cause,
      });
    };

  const list: IssueService["Service"]["list"] = (input) => {
    const key = JSON.stringify([
      input.projectId,
      input.state,
      input.limit ?? null,
      input.cursor ?? null,
    ]);
    return Cache.get(listCache, key);
  };

  const detail: IssueService["Service"]["detail"] = (input) =>
    Cache.get(detailCache, `${input.projectId}#${input.number}`);

  const invalidate: IssueService["Service"]["invalidate"] = Effect.all([
    Cache.invalidateAll(listCache),
    Cache.invalidateAll(detailCache),
  ]);

  return IssueService.of({ list, detail, invalidate });
});

export const layer = Layer.effect(IssueService, make);
