"use client";

import { Card, Badge } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import {
  SKILLS,
  SKILLS_REPO_URL,
  getSkillRawUrl,
  getSkillBlobUrl,
} from "@/shared/constants/skills";

function CopyButton({ value, label = "Copy link" }) {
  const { copied, copy } = useCopyToClipboard(2000);
  return (
    <button
      onClick={() => copy(value)}
      className="inline-flex w-full items-center justify-center gap-1 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-primary/90 sm:w-auto sm:shrink-0 sm:px-2 sm:py-1 sm:text-[11px]"
      title={value}
    >
      <span className="material-symbols-outlined text-[12px]">
        {copied ? "check" : "content_copy"}
      </span>
      {copied ? "Copied!" : label}
    </button>
  );
}

function SkillRow({ skill }) {
  const url = getSkillRawUrl(skill.id);
  return (
    <div
      className={`flex min-w-0 flex-col gap-3 rounded-[14px] border p-3 shadow-[var(--shadow-soft)] transition-colors sm:flex-row sm:items-start sm:p-4 ${
        skill.isEntry
          ? "border-brand-500/40 bg-brand-500/5"
          : "border-border-subtle bg-surface hover:bg-surface-2"
      }`}
    >
      <div className="flex min-w-0 items-start gap-3 sm:contents">
        <div
          className={`size-9 shrink-0 rounded-lg flex items-center justify-center ${
          skill.isEntry ? "bg-primary text-white" : "bg-primary/10 text-primary"
        }`}
        >
          <span className="material-symbols-outlined text-[18px]">{skill.icon}</span>
        </div>

        <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="font-semibold text-sm text-text-main">{skill.name}</h3>
          {skill.isEntry && (
            <Badge variant="primary" size="sm">START HERE</Badge>
          )}
          {skill.endpoint && (
            <Badge variant="default" size="sm">
              <code className="text-[10px]">{skill.endpoint}</code>
            </Badge>
          )}
        </div>
        <p className="text-xs text-text-muted mt-0.5">{skill.description}</p>
        <a
          href={getSkillBlobUrl(skill.id)}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex max-w-full items-center gap-1 rounded-md bg-surface-2 px-2 py-1 font-mono text-[10px] text-text-muted hover:text-primary sm:bg-transparent sm:px-0 sm:py-0 sm:text-[11px]"
        >
          <span className="min-w-0 truncate">{url}</span>
          <span className="material-symbols-outlined shrink-0 text-[12px]">open_in_new</span>
        </a>
        </div>
      </div>

      <CopyButton value={url} />
    </div>
  );
}

export default function SkillsPage() {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 px-1 sm:space-y-6 sm:px-0">
      <Card padding="md">
        <div className="mb-2 text-xs text-text-muted">Paste this to your AI:</div>
        <div className="overflow-x-auto rounded-lg bg-surface-2 px-3 py-2 font-mono text-[11px] leading-relaxed text-text-main sm:text-[12px]">
          <span className="whitespace-nowrap">Read this skill and use it: {getSkillRawUrl("9router")}</span>
        </div>
      </Card>

      <div className="space-y-2">
        {SKILLS.map((skill) => (
          <SkillRow key={skill.id} skill={skill} />
        ))}
      </div>

      <Card padding="md">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-text-main">More on GitHub</h2>
            <p className="text-xs text-text-muted mt-0.5">
              Browse source, README, and examples.
            </p>
          </div>
          <a
            href={`${SKILLS_REPO_URL}/tree/master/skills`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex w-full items-center justify-center gap-1 rounded-lg border border-primary/25 bg-primary/10 px-3 py-2 text-sm font-medium text-primary hover:bg-primary/15 sm:w-auto sm:border-0 sm:bg-transparent sm:px-0 sm:py-0 sm:hover:bg-transparent sm:hover:underline"
          >
            <span className="material-symbols-outlined text-[16px]">open_in_new</span>
            View on GitHub
          </a>
        </div>
      </Card>
    </div>
  );
}
