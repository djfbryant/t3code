import type {
  EnvironmentId,
  IssueComment,
  IssueDetail,
  IssueListInput,
  IssueListResult,
  ProjectId,
  PullRequestLabel,
} from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import {
  CheckCircle2Icon,
  ChevronLeftIcon,
  CircleDotIcon,
  ExternalLinkIcon,
  MessageSquareIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { issueEnvironment, useIssueDetail, useIssueList } from "../state/issues";
import { useAtomCommand } from "../state/use-atom-command";
import { useEnvironments } from "../state/environments";
import { useProjects } from "../state/entities";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { cn } from "../lib/utils";
import ChatMarkdown from "../components/ChatMarkdown";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../components/ui/menu";
import { RefreshIcon } from "../components/ui/refresh-icon";
import { Spinner } from "../components/ui/spinner";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../components/WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../components/WorkspacePageContainer";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { isElectron } from "../env";

const PAGE_STEP = 30;
const STATE_TABS = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
] as const;

export const Route = createFileRoute("/_chat/issues")({
  component: IssuesRoute,
});

function IssuesRoute() {
  const { environments } = useEnvironments();
  const projects = useProjects();
  // One server advertising the tracker is enough for every project on that server to be
  // listed; a project on a server that does not report it fails visibly only once chosen,
  // which keeps this page honest about what it can read without probing servers up front.
  const issueProjects = useMemo(() => {
    const supported = new Set(
      environments
        .filter((environment) => environment.serverConfig?.environment.capabilities.issues === true)
        .map((environment) => environment.environmentId),
    );
    return projects.filter((project) => supported.has(project.environmentId));
  }, [environments, projects]);

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [state, setState] = useState<IssueListInput["state"]>("open");
  const [limit, setLimit] = useState(PAGE_STEP);
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);

  const project =
    selectedProjectId === null ||
    !issueProjects.some((candidate) => candidate.id === selectedProjectId)
      ? (issueProjects[0] ?? null)
      : (issueProjects.find((candidate) => candidate.id === selectedProjectId) ?? null);

  const selectProject = useCallback((nextProjectId: string) => {
    setSelectedProjectId(nextProjectId);
    setLimit(PAGE_STEP);
    setSelectedNumber(null);
  }, []);

  const environmentId: EnvironmentId | null = project?.environmentId ?? null;
  const projectId: ProjectId | null = project?.id ?? null;
  const listInput: IssueListInput | null =
    project === null ? null : { projectId: project.id, state, limit };

  const { data, error, isPending } = useIssueList(environmentId, listInput);

  const invalidate = useAtomCommand(issueEnvironment.invalidate, { reportFailure: false });
  const [invalidating, setInvalidating] = useState(false);
  const [detailRefreshToken, setDetailRefreshToken] = useState(0);
  // The header's refresh punches through the server's cache before re-reading; the same
  // shape the pull-request page makes, minus the stats and partitions it has to sweep.
  const refreshFromHost = async () => {
    if (environmentId === null || projectId === null) return;
    setInvalidating(true);
    try {
      await invalidate({ environmentId, input: {} });
    } finally {
      setInvalidating(false);
    }
    appAtomRegistry.refresh(
      issueEnvironment.list({
        environmentId,
        input: { projectId, state, limit },
      }),
    );
    setDetailRefreshToken((token) => token + 1);
  };

  const refreshing = invalidating || isPending;
  const detailOpen = selectedNumber !== null && project !== null;
  const changeState = (next: IssueListInput["state"]) => {
    setState(next);
    // The selected issue may not exist in the other side of the list; a pane showing an
    // issue the list can no longer show reads as a stale page.
    setSelectedNumber(null);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <WorkspacePageHeader electron={isElectron} className="relative bg-background">
        <WorkspaceBreadcrumb ariaLabel="Tracker breadcrumb">
          {detailOpen && project !== null ? (
            <>
              <WorkspaceBreadcrumbItem className="shrink">
                <Button variant="ghost" size="compact" onClick={() => setSelectedNumber(null)}>
                  <ChevronLeftIcon aria-hidden className="size-3.5" />
                  <span>View list</span>
                </Button>
              </WorkspaceBreadcrumbItem>
              <WorkspaceBreadcrumbSeparator />
              <WorkspaceBreadcrumbItem current>
                <h1 className="truncate">#{selectedNumber}</h1>
              </WorkspaceBreadcrumbItem>
            </>
          ) : (
            <>
              <WorkspaceBreadcrumbItem current>
                <h1 className="truncate">Tracker</h1>
              </WorkspaceBreadcrumbItem>
              {project === null ? null : (
                <>
                  <WorkspaceBreadcrumbSeparator />
                  <WorkspaceBreadcrumbItem className="shrink gap-1.5">
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button variant="ghost" size="compact" className="max-w-48 min-w-0">
                            <span className="min-w-0 truncate">{project.title}</span>
                          </Button>
                        }
                      />
                      <MenuPopup align="start">
                        <MenuRadioGroup
                          value={project.id}
                          onValueChange={(value) => selectProject(value as string)}
                        >
                          {issueProjects.map((candidate) => (
                            <MenuRadioItem key={candidate.id} value={candidate.id}>
                              {candidate.title}
                            </MenuRadioItem>
                          ))}
                        </MenuRadioGroup>
                      </MenuPopup>
                    </Menu>
                    <ToggleGroup
                      aria-label="Filter by state"
                      variant="segmented"
                      value={[state]}
                      onValueChange={(next) => {
                        const selected = STATE_TABS.find((tab) => tab.value === next[0]);
                        if (selected) changeState(selected.value);
                      }}
                    >
                      {STATE_TABS.map((tab) => (
                        <Toggle key={tab.value} value={tab.value}>
                          {tab.label}
                        </Toggle>
                      ))}
                    </ToggleGroup>
                    {refreshing && data === null ? (
                      <Spinner className="text-muted-foreground" />
                    ) : null}
                  </WorkspaceBreadcrumbItem>
                </>
              )}
            </>
          )}
        </WorkspaceBreadcrumb>
        <div className="min-w-0 flex-1" />
        <Button
          size="icon"
          variant="outline"
          aria-label="Refresh issues"
          onClick={() => void refreshFromHost()}
          disabled={refreshing || project === null}
        >
          <RefreshIcon className="size-4" refreshing={refreshing} />
        </Button>
      </WorkspacePageHeader>

      <div className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
        {project === null ? (
          <WorkspacePageContainer width="expanded" className="min-h-full gap-4">
            <IssuesUnavailableState
              title="Nothing to read yet"
              error="Add a project backed by a GitHub repository, then open the tracker again."
            />
          </WorkspacePageContainer>
        ) : detailOpen && selectedNumber !== null ? (
          // The issue replaces the list, like a page drill-down: a full-width read is the
          // point of opening one, and the breadcrumb above is the way back.
          <WorkspacePageContainer width="readable" className="min-h-full gap-4">
            <IssueDetailPanel
              environmentId={project.environmentId}
              projectId={project.id}
              number={selectedNumber}
              refreshToken={detailRefreshToken}
            />
          </WorkspacePageContainer>
        ) : (
          <WorkspacePageContainer width="expanded" className="min-h-full gap-4">
            <div className="flex min-w-0 flex-col gap-1">
              <IssueListBody
                data={data}
                error={error}
                isPending={isPending}
                state={state}
                selectedNumber={selectedNumber}
                onSelect={setSelectedNumber}
                onRetry={() => {
                  if (environmentId === null || listInput === null) return;
                  appAtomRegistry.refresh(
                    issueEnvironment.list({ environmentId, input: listInput }),
                  );
                }}
                onLoadMore={() => setLimit((current) => current + PAGE_STEP)}
              />
            </div>
          </WorkspacePageContainer>
        )}
      </div>
    </div>
  );
}

function IssueListBody({
  data,
  error,
  isPending,
  state,
  selectedNumber,
  onSelect,
  onRetry,
  onLoadMore,
}: {
  data: IssueListResult | null;
  error: string | null;
  isPending: boolean;
  state: IssueListInput["state"];
  selectedNumber: number | null;
  onSelect: (number: number) => void;
  onRetry: () => void;
  onLoadMore: () => void;
}) {
  if (error !== null) {
    return <IssuesUnavailableState error={error} onRetry={onRetry} refreshing={isPending} />;
  }
  if (data === null) {
    return (
      <Empty className="py-16">
        <Spinner className="text-muted-foreground" />
      </Empty>
    );
  }
  if (data.entries.length === 0) {
    return (
      <Empty className="py-16">
        <EmptyMedia variant="icon">
          <CircleDotIcon />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>{state === "open" ? "No open issues" : "No closed issues"}</EmptyTitle>
          <EmptyDescription>
            {state === "open"
              ? "Everything this repository has filed is closed. New issues appear here as they arrive."
              : "Nothing has been closed yet."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <>
      <ul className="overflow-hidden rounded-xl border">
        {data.entries.map((entry) => (
          <li key={entry.number}>
            <IssueRow
              entry={entry}
              selected={entry.number === selectedNumber}
              onSelect={() => onSelect(entry.number)}
            />
          </li>
        ))}
      </ul>
      {data.truncated ? (
        <div className="flex justify-center py-2">
          <Button size="sm" variant="outline" onClick={onLoadMore} disabled={isPending}>
            Load more
          </Button>
        </div>
      ) : null}
    </>
  );
}

function IssueRow({
  entry,
  selected,
  onSelect,
}: {
  entry: IssueListResult["entries"][number];
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected || undefined}
      className={cn(
        "flex w-full items-start gap-3 border-b px-3 py-2.5 text-left text-sm last:border-b-0 hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-hidden",
        selected && "bg-accent",
      )}
    >
      {entry.state === "open" ? (
        <CircleDotIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
      ) : (
        <CheckCircle2Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium">{entry.title}</span>
          <span className="shrink-0 text-xs text-muted-foreground">#{entry.number}</span>
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>
            {entry.author === null ? "ghost" : entry.author.login} ·{" "}
            {formatRelativeTimeLabel(entry.createdAt)}
          </span>
          {entry.commentCount > 0 ? (
            <span className="inline-flex items-center gap-1">
              <MessageSquareIcon aria-hidden className="size-3" />
              {entry.commentCount}
            </span>
          ) : null}
          {entry.labels.slice(0, 4).map((label) => (
            <IssueLabelPill key={label.name} label={label} />
          ))}
        </span>
      </span>
    </button>
  );
}

function IssueLabelPill({ label }: { label: PullRequestLabel }) {
  return (
    <Badge
      variant="secondary"
      className="px-1.5 py-0 text-xs"
      style={
        label.color === null
          ? undefined
          : { backgroundColor: `#${label.color}22`, color: `#${label.color}` }
      }
    >
      {label.name}
    </Badge>
  );
}

function IssueDetailPanel({
  environmentId,
  projectId,
  number,
  refreshToken,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  number: number;
  refreshToken: number;
}) {
  const reference = useMemo(() => ({ projectId, number }), [projectId, number]);
  // A refresh asked for by the page: the page cannot reach this panel's reads, so it says
  // when, and this says it — the same pattern the pull-request detail panel uses.
  const appliedRefreshToken = useRef(0);
  useEffect(() => {
    if (appliedRefreshToken.current === refreshToken) return;
    appliedRefreshToken.current = refreshToken;
    appAtomRegistry.refresh(issueEnvironment.detail({ environmentId, input: reference }));
  }, [environmentId, reference, refreshToken]);

  const { data, error, isPending } = useIssueDetail(environmentId, reference);

  return (
    <section className="flex min-h-0 min-w-0 flex-col">
      {error !== null ? (
        <IssuesUnavailableState error={error} refreshing={isPending} />
      ) : data === null ? (
        <Empty className="py-16">
          <Spinner className="text-muted-foreground" />
        </Empty>
      ) : (
        <IssueDetailContent detail={data} environmentId={environmentId} />
      )}
    </section>
  );
}

function IssueDetailContent({
  detail,
  environmentId,
}: {
  detail: IssueDetail;
  environmentId: EnvironmentId;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          {detail.state === "open" ? (
            <CircleDotIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
          ) : (
            <CheckCircle2Icon
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            />
          )}
          <h2 className="min-w-0 text-base font-medium leading-snug">{detail.title}</h2>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Open on GitHub"
          render={<a href={detail.url} target="_blank" rel="noopener noreferrer" />}
        >
          <ExternalLinkIcon className="size-4" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>
          {detail.author === null ? "ghost" : detail.author.login} ·{" "}
          {formatRelativeTimeLabel(detail.createdAt)}
        </span>
        {detail.commentCount > 0 ? (
          <span className="inline-flex items-center gap-1">
            <MessageSquareIcon aria-hidden className="size-3" />
            {detail.commentCount}
          </span>
        ) : null}
        {detail.labels.map((label) => (
          <IssueLabelPill key={label.name} label={label} />
        ))}
      </div>
      <ChatMarkdown text={detail.body} cwd={detail.workspaceRoot} environmentId={environmentId} />
      {detail.comments.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {detail.comments.map((comment) => (
            <IssueDetailComment key={comment.id} comment={comment} environmentId={environmentId} />
          ))}
        </ul>
      ) : null}
      {detail.commentsTruncated ? (
        <p className="text-xs text-muted-foreground">
          {detail.commentCount - detail.comments.length} older remarks are on GitHub.
        </p>
      ) : null}
    </div>
  );
}

function IssueDetailComment({
  comment,
  environmentId,
}: {
  comment: IssueComment;
  environmentId: EnvironmentId;
}) {
  return (
    <li className="flex flex-col gap-1 rounded-lg border px-3 py-2">
      <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{comment.author?.login ?? "ghost"}</span>
        <span>{formatRelativeTimeLabel(comment.createdAt)}</span>
        {comment.url !== null ? (
          <a
            href={comment.url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-muted-foreground hover:text-foreground"
            aria-label="Open comment on GitHub"
          >
            <ExternalLinkIcon aria-hidden className="size-3" />
          </a>
        ) : null}
      </div>
      <ChatMarkdown text={comment.body} cwd={undefined} environmentId={environmentId} />
    </li>
  );
}

function IssuesUnavailableState({
  title = "Could not load issues",
  error,
  onRetry,
  refreshing = false,
}: {
  title?: string;
  error: string;
  onRetry?: () => void;
  refreshing?: boolean;
}) {
  return (
    <Empty className="min-h-0 justify-center-safe overflow-y-auto px-4 py-16 md:px-4 [&>*]:shrink-0">
      <EmptyMedia variant="icon">
        <TriangleAlertIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {/* The server names the fix — install gh, sign in, point the project at GitHub — so
            this shows its message as-is rather than trying to infer one from the failure. */}
        <EmptyDescription>{error}</EmptyDescription>
      </EmptyHeader>
      {onRetry ? (
        <EmptyContent className="flex-row flex-wrap justify-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={onRetry}
            disabled={refreshing}
            aria-busy={refreshing}
          >
            <RefreshIcon className="size-3.5" refreshing={refreshing} />
            Retry
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
