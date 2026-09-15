import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { PullRequestActor, PullRequestLabel } from "./pullRequest.ts";

/** An issue's own state, which a list can also ask for across both. */
export const IssueState = Schema.Literals(["open", "closed"]);
export type IssueState = typeof IssueState.Type;

export const IssueListState = Schema.Literals(["all", "open", "closed"]);
export type IssueListState = typeof IssueListState.Type;

/**
 * One issue in the tracker. GitHub-only today; the shape stays host-neutral so a later
 * provider fills the same rows.
 */
export const IssueListEntry = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  state: IssueState,
  labels: Schema.Array(PullRequestLabel),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  commentCount: NonNegativeInt,
});
export type IssueListEntry = typeof IssueListEntry.Type;

export const IssueListInput = Schema.Struct({
  /** The project whose repository the tracker reads. */
  projectId: ProjectId,
  state: IssueListState,
  /** Rows to return. Absent takes the server's own page size. */
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  /**
   * Where the last answer stopped, sent straight back as it arrived. Opaque to the page: only
   * the host's own numbering knows what it means.
   */
  cursor: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
});
export type IssueListInput = typeof IssueListInput.Type;

export const IssueListResult = Schema.Struct({
  entries: Schema.Array(IssueListEntry),
  /** The host has more rows than this answer holds. */
  truncated: Schema.Boolean,
  /** Where the next page starts, or null once the listing is whole. */
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
});
export type IssueListResult = typeof IssueListResult.Type;

/**
 * Addresses one issue for a read. The repository is not named because the tracker is bound to
 * the project: the server reads the project's own remote, which is the one place that knows it.
 */
export const IssueRef = Schema.Struct({
  projectId: ProjectId,
  number: PositiveInt,
});
export type IssueRef = typeof IssueRef.Type;

export const IssueComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  body: Schema.String,
  createdAt: IsoDateTime,
  url: Schema.NullOr(Schema.String),
});
export type IssueComment = typeof IssueComment.Type;

export const IssueDetail = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  body: Schema.String,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  state: IssueState,
  labels: Schema.Array(PullRequestLabel),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** The host's own count of the conversation, which a bounded read can fall short of. */
  commentCount: NonNegativeInt,
  comments: Schema.Array(IssueComment),
  /** The read stopped at its own bound before the host ran out of conversation. */
  commentsTruncated: Schema.Boolean,
});
export type IssueDetail = typeof IssueDetail.Type;

/** Forget what the server has cached, so the next read asks the host again. */
export const IssueInvalidateInput = Schema.Struct({});
export type IssueInvalidateInput = typeof IssueInvalidateInput.Type;

export const IssueUnavailableReason = Schema.Literals([
  "cli-missing",
  "cli-unauthenticated",
  "rate-limited",
  "provider-unsupported",
]);
export type IssueUnavailableReason = typeof IssueUnavailableReason.Type;

/**
 * What a host needs before its issues can be read, as a sentence the page shows as-is. GitHub
 * is the only provider here today, which is why the map holds one entry.
 */
const PROVIDER_REQUIREMENT: Record<IssueUnavailableReason, string> = {
  "cli-missing":
    "GitHub CLI (`gh`) is required to browse issues on this host. Install it from https://cli.github.com/ and reload.",
  "cli-unauthenticated": "GitHub CLI is not authenticated. Run `gh auth login` and retry.",
  "rate-limited": "GitHub is rate limiting this host. Try again shortly.",
  "provider-unsupported": "Issues cannot be browsed for this project's host yet.",
};

/**
 * The tracker is switched off for this host or cannot be reached. The message is derived from
 * `reason` rather than from whatever the CLI printed, so it stays a stable sentence the UI can
 * show as-is.
 */
export class IssueUnavailableError extends Schema.TaggedError<IssueUnavailableError>()(
  "IssueUnavailableError",
  {
    reason: IssueUnavailableReason,
    cause: Schema.optional(Schema.Defect()),
  },
  { httpApiStatus: 503 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(IssueUnavailableError)(this, { status: 503 });
  }

  override get message(): string {
    return PROVIDER_REQUIREMENT[this.reason];
  }
}

export class IssueOperationError extends Schema.TaggedError<IssueOperationError>()(
  "IssueOperationError",
  {
    operation: Schema.String,
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
  { httpApiStatus: 502 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(IssueOperationError)(this, { status: 502 });
  }

  override get message(): string {
    return `Issue operation ${this.operation} failed: ${this.detail}`;
  }
}
