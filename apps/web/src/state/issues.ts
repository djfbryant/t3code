import { createIssueEnvironmentAtoms } from "@t3tools/client-runtime/state/issues";
import type { EnvironmentId, IssueListInput, IssueRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { Atom, AsyncResult } from "effect/unstable/reactivity";
import { useAtomValue } from "@effect/atom-react";

import { connectionAtomRuntime } from "../connection/runtime";
import { formatEnvironmentQueryError } from "./query";

export const issueEnvironment = createIssueEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_RESULT_ATOM = Atom.make(
  AsyncResult.failure<never, never>(
    Cause.fail(new Error("No environment selected.")) as Cause.Cause<never>,
  ),
).pipe(Atom.setIdleTTL(30_000), Atom.withLabel("web-issues:empty"));

/** One environment's tracker answer, or the error that stood in its way. */
export function useIssueList(environmentId: EnvironmentId | null, input: IssueListInput | null) {
  const result = useAtomValue(
    environmentId === null || input === null
      ? EMPTY_RESULT_ATOM
      : issueEnvironment.list({ environmentId, input }),
  );
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
    isPending: result.waiting,
  };
}

export function useIssueDetail(environmentId: EnvironmentId | null, ref: IssueRef | null) {
  const result = useAtomValue(
    environmentId === null || ref === null
      ? EMPTY_RESULT_ATOM
      : issueEnvironment.detail({ environmentId, input: ref }),
  );
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
    isPending: result.waiting,
  };
}
