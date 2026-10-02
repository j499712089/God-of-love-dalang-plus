import { boundedContext, relevantEvents, type MemoryEvent } from "./memory";
import type { Message, Relation, LineResult, AnalysisRequest } from "./types";
export function incrementalJobs(
  messages: Message[],
  relation: Relation,
  revision: number,
  lines: Record<string, LineResult>,
  events: Record<string, MemoryEvent>,
  changed: boolean,
): AnalysisRequest[] {
  const recentIds = new Set(
    changed
      ? messages
          .slice(-20)
          .filter((m) => m.sender === "other")
          .map((m) => m.id)
      : [],
  );
  const jobs: AnalysisRequest[] = [];
  const historical = changed
    ? boundedContext(
        messages,
        Math.max(0, messages.length - 100),
        messages.length,
        events,
      )
    : undefined;
  if (historical)
    for (const e of relevantEvents(messages, events, messages.slice(-20)).slice(
      0,
      4,
    )) {
      if (
        historical.messages.some((m) => m.id === e.id && m.sender === "other")
      )
        jobs.push({
          task: "other_messages",
          targetIds: [e.id],
          ...historical,
          revision,
          relation,
        });
    }

  for (let start = 0; start < messages.length;) {
    let end = start,
      chars = 0;
    while (end < messages.length && end - start < 10) {
      const n = Array.from(messages[end].text).length;
      if (end > start && chars + n > 1500) break;
      chars += n;
      end++;
    }
    for (const sender of ["other", "self"] as const) {
      const targets = messages
        .slice(start, end)
        .filter(
          (m) =>
            m.sender === sender &&
            m.kind === "text" &&
            Array.from(m.text).length <= 12000 &&
            (!lines[m.id] || recentIds.has(m.id)),
        );
      if (!targets.length) continue;
      const lastIndex = messages.findIndex((m) => m.id === targets.at(-1)!.id);
      // Revisit counterparts with a little later context; never expose future text to self ratings.
      const contextEnd =
        sender === "self" ? lastIndex + 1 : Math.min(messages.length, end + 20);
      const context = boundedContext(
        messages,
        Math.max(0, start - 20),
        contextEnd,
        events,
        sender === "self",
      );
      // Long contexts may omit early targets. Split those into individual bounded jobs.
      for (const target of targets.filter(
        (m) => !context.messages.some((c) => c.id === m.id),
      )) {
        const i = messages.findIndex((m) => m.id === target.id);
        jobs.push({
          task: sender === "self" ? "self_message" : "other_messages",
          targetIds: [target.id],
          ...boundedContext(messages, Math.max(0, i - 20), i + 1, events, true),
          revision,
          relation,
        });
      }
      const ids = targets
        .filter((m) => context.messages.some((c) => c.id === m.id))
        .map((m) => m.id);
      if (ids.length)
        jobs.push({
          task: sender === "self" ? "self_message" : "other_messages",
          targetIds: ids,
          ...context,
          revision,
          relation,
        });
    }
    start = end;
  }
  return jobs.reverse();
}
export function overviewJob(
  messages: Message[],
  relation: Relation,
  revision: number,
  events: Record<string, MemoryEvent>,
): AnalysisRequest {
  return {
    task: "overview",
    targetIds: [],
    revision,
    relation,
    ...boundedContext(
      messages,
      Math.max(0, messages.length - 100),
      messages.length,
      events,
    ),
  };
}
