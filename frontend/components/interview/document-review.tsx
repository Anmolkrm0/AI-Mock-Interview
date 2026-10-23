"use client";

import { Pencil } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/field";
import { errorMessage } from "@/lib/api";
import { documentsApi } from "@/services/interviews";
import type { DocumentOut, JobData, ResumeData } from "@/types/api";

function Chips({ items, empty }: { items: string[]; empty: string }) {
  if (!items.length) return <p className="text-sm text-slate">{empty}</p>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {items.map((s) => (
        <li key={s} className="rounded-sm bg-paper px-2 py-0.5 text-sm ring-1 ring-line">
          {s}
        </li>
      ))}
    </ul>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-[9rem_1fr] sm:gap-4">
      <dt className="text-sm text-slate">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const splitList = (v: string) =>
  v
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

export function ResumeReview({ doc, onUpdated }: { doc: DocumentOut; onUpdated: (d: DocumentOut) => void }) {
  const data = (doc.extracted_data ?? {}) as unknown as ResumeData;
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [skills, setSkills] = useState((data.skills ?? []).join(", "));
  const [tools, setTools] = useState((data.tools_and_technologies ?? []).join(", "));
  const [years, setYears] = useState(data.total_experience_years?.toString() ?? "");

  async function save() {
    setSaving(true);
    try {
      const parsedYears = years.trim() === "" ? null : Number(years);
      if (parsedYears !== null && (Number.isNaN(parsedYears) || parsedYears < 0 || parsedYears > 60)) {
        toast.error("Enter years of experience between 0 and 60, or leave it blank.");
        return;
      }
      const updated = await documentsApi.correct(doc.id, {
        ...data,
        skills: splitList(skills),
        tools_and_technologies: splitList(tools),
        total_experience_years: parsedYears,
      });
      onUpdated(updated);
      setEditing(false);
      toast.success("Resume details saved.");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="r-skills">Skills (comma separated)</Label>
          <Textarea id="r-skills" value={skills} onChange={(e) => setSkills(e.target.value)} className="min-h-20" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="r-tools">Tools and technologies</Label>
          <Textarea id="r-tools" value={tools} onChange={(e) => setTools(e.target.value)} className="min-h-20" />
        </div>
        <div className="max-w-40 space-y-1.5">
          <Label htmlFor="r-years">Years of experience</Label>
          <Input id="r-years" inputMode="decimal" value={years} onChange={(e) => setYears(e.target.value)} />
        </div>
        <div className="flex gap-2">
          <Button onClick={save} loading={saving}>
            Save details
          </Button>
          <Button variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <dl className="space-y-3">
        {data.headline && <Row label="Headline">{data.headline}</Row>}
        <Row label="Experience">
          {data.total_experience_years != null ? (
            `${data.total_experience_years} years`
          ) : (
            <span className="text-slate">Not stated</span>
          )}
        </Row>
        <Row label="Skills">
          <Chips items={data.skills ?? []} empty="None found" />
        </Row>
        <Row label="Tools">
          <Chips items={data.tools_and_technologies ?? []} empty="None found" />
        </Row>
        <Row label="Projects">
          {data.projects?.length ? (
            <ul className="space-y-1 text-[15px]">
              {data.projects.slice(0, 4).map((p) => (
                <li key={p.name}>
                  <span className="font-medium">{p.name}</span>
                  {p.description ? `: ${p.description}` : ""}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-sm text-slate">None found</span>
          )}
        </Row>
      </dl>
      <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
        <Pencil /> Correct details
      </Button>
    </div>
  );
}

const SENIORITY = ["intern", "entry", "mid", "senior", "lead", "principal", "executive", "unknown"];

export function JobReview({ doc, onUpdated }: { doc: DocumentOut; onUpdated: (d: DocumentOut) => void }) {
  const data = (doc.extracted_data ?? {}) as unknown as JobData;
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState(data.job_title ?? "");
  const [seniority, setSeniority] = useState(data.seniority ?? "unknown");
  const [required, setRequired] = useState((data.required_skills ?? []).join(", "));

  async function save() {
    setSaving(true);
    try {
      const updated = await documentsApi.correct(doc.id, {
        ...data,
        job_title: title.trim() || null,
        seniority,
        required_skills: splitList(required),
      });
      onUpdated(updated);
      setEditing(false);
      toast.success("Job details saved.");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="j-title">Job title</Label>
          <Input id="j-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="max-w-56 space-y-1.5">
          <Label htmlFor="j-level">Seniority</Label>
          <select
            id="j-level"
            value={seniority}
            onChange={(e) => setSeniority(e.target.value)}
            className="h-11 w-full rounded-md border border-line-strong bg-surface px-3 capitalize"
          >
            {SENIORITY.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="j-req">Required skills (comma separated)</Label>
          <Textarea id="j-req" value={required} onChange={(e) => setRequired(e.target.value)} className="min-h-20" />
        </div>
        <div className="flex gap-2">
          <Button onClick={save} loading={saving}>
            Save details
          </Button>
          <Button variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <dl className="space-y-3">
        <Row label="Title">{data.job_title ?? <span className="text-slate">Not stated</span>}</Row>
        <Row label="Seniority">
          <span className="capitalize">{data.seniority}</span>
        </Row>
        {data.required_experience && <Row label="Experience">{data.required_experience}</Row>}
        <Row label="Required">
          <Chips items={data.required_skills ?? []} empty="None found" />
        </Row>
        <Row label="Nice to have">
          <Chips items={data.preferred_skills ?? []} empty="None listed" />
        </Row>
        <Row label="Topics">
          <Chips items={data.interview_topics ?? []} empty="None found" />
        </Row>
      </dl>
      <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
        <Pencil /> Correct details
      </Button>
    </div>
  );
}
