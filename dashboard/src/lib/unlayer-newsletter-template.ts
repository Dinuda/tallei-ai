import newsletterTemplate from "./newsletter-template.json";

type UnlayerDesign = {
  counters: Record<string, number>;
  body: Record<string, unknown>;
};

type UnlayerBlock = {
  id: string;
  type: string;
  values: Record<string, unknown>;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function parseMarkdown(markdown: string): Array<{ type: "heading" | "text" | "intro" | "closing" | "subject"; level?: number; text: string }> {
  const result: Array<{ type: "heading" | "text" | "intro" | "closing" | "subject"; level?: number; text: string }> = [];
  const lines = markdown.split("\n");
  let buffer: string[] = [];

  function flushBuffer() {
    if (buffer.length === 0) return;
    const raw = buffer.join(" ").trim();
    if (!raw) { buffer = []; return; }

    // Detect italic intro pattern
    if (/^\*what i read/i.test(raw) || /^\*a summary of/i.test(raw)) {
      result.push({ type: "intro", text: raw.replace(/^\*|\*$/g, "").trim() });
      buffer = [];
      return;
    }

    // Detect closing sign-off
    if (/^that's all for this week/i.test(raw) || /^thanks for reading/i.test(raw) || /^see you next/i.test(raw)) {
      result.push({ type: "closing", text: raw });
      buffer = [];
      return;
    }

    const html = raw
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a style="color:#7c3aed;" href="$2">$1</a>');
    result.push({ type: "text", text: html });
    buffer = [];
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushBuffer(); continue; }

    // Detect Subject: metadata line
    const subjectMatch = line.match(/^Subject:\s*(.+)$/i);
    if (subjectMatch) {
      flushBuffer();
      result.push({ type: "subject", text: subjectMatch[1].trim() });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushBuffer();
      const level = heading[1].length;
      result.push({ type: "heading", level, text: heading[2] });
      continue;
    }

    // Handle inline italic intro on its own line
    if (/^\*.+\*$/.test(line)) {
      flushBuffer();
      result.push({ type: "intro", text: line.replace(/^\*|\*$/g, "").trim() });
      continue;
    }

    buffer.push(line);
  }
  flushBuffer();
  return result;
}

type PopulateOptions = {
  subject?: string;
  greeting?: string;
};

function populateSubstackTemplate(
  design: UnlayerDesign,
  parsed: ReturnType<typeof parseMarkdown>,
  options?: PopulateOptions,
): UnlayerDesign {
  const body = design.body as { rows?: Array<Record<string, unknown>> };
  if (!body.rows) return design;

  // Extract sections from parsed markdown
  const parsedSubject = parsed.find((p) => p.type === "subject")?.text;
  const subjectLine = parsed.find((p) => p.type === "heading" && p.level === 1);
  const subtitleText = parsed.find((p) => p.type === "text" && !parsed.slice(0, parsed.indexOf(p)).some((x) => x.type === "heading" && x.level === 2));
  const introItem = parsed.find((p) => p.type === "intro");
  const sectionHeading = parsed.find((p) => p.type === "heading" && p.level === 2);
  const closingItem = parsed.find((p) => p.type === "closing");

  // Collect h3 items and their following paragraphs
  const items: Array<{ title: string; body: string[] }> = [];
  let currentItem: { title: string; body: string[] } | null = null;
  for (const block of parsed) {
    if (block.type === "heading" && block.level === 3) {
      if (currentItem) items.push(currentItem);
      currentItem = { title: block.text, body: [] };
    } else if (block.type === "text" && currentItem) {
      currentItem.body.push(block.text);
    }
  }
  if (currentItem) items.push(currentItem);

  // Helper to find a row by its first column's id pattern
  function findRow(pattern: string): Record<string, unknown> | undefined {
    return body.rows?.find((row) => {
      const columns = row.columns as Array<{ id?: string }> | undefined;
      return columns?.some((col) => col.id?.includes(pattern));
    });
  }

  function updateBlockText(rowPattern: string, contentIdPattern: string, newText: string) {
    const row = findRow(rowPattern);
    if (!row) return;
    const columns = row.columns as Array<{ contents?: Array<Record<string, unknown>> }> | undefined;
    if (!columns) return;
    for (const col of columns) {
      const contents = col.contents ?? [];
      for (const content of contents) {
        const id = (content as Record<string, unknown>).id as string | undefined;
        if (id?.includes(contentIdPattern)) {
          const values = (content as Record<string, unknown>).values as Record<string, unknown> | undefined;
          if (values) values.text = newText;
        }
      }
    }
  }

  // Update headline from explicit subject > parsed Subject: > h1
  const subjectText = options?.subject ?? parsedSubject ?? subjectLine?.text ?? "";
  if (subjectText) {
    updateBlockText("headline", "heading-headline", subjectText);
  }

  // Update subtitle
  if (subtitleText) {
    updateBlockText("headline", "text-subtitle", `<p style="line-height: 150%;">${subtitleText.text}</p>`);
  }

  // Update author date to today
  const today = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  updateBlockText("headline", "text-date", `<p style="line-height: 140%;">${today.toUpperCase()}</p>`);

  // Update intro from explicit greeting > parsed italic intro
  const greetingText = options?.greeting ?? introItem?.text ?? "";
  if (greetingText) {
    updateBlockText("intro", "text-intro-label", `<p style="line-height: 160%;"><em>${greetingText}</em></p>`);
  }

  // Update section heading
  if (sectionHeading) {
    updateBlockText("section", "heading-section", sectionHeading.text);
  }

  // Update item blocks (up to 3)
  const itemRows = ["item-1", "item-2", "item-3"];
  for (let i = 0; i < itemRows.length; i++) {
    const item = items[i];
    if (!item) break;
    updateBlockText(itemRows[i], `heading-item-${i + 1}`, item.title);
    const bodyHtml = item.body.map((p) => `<p style="line-height: 180%;">${p}</p>`).join("");
    updateBlockText(itemRows[i], `text-item-${i + 1}`, bodyHtml);
  }

  // Update closing
  if (closingItem) {
    updateBlockText("closing", "text-closing", `<p style="line-height: 180%;">${closingItem.text}</p>`);
  }

  return design;
}

export function getLoadableUnlayerDesign(
  initialDesign: unknown,
  initialMarkdown: string | undefined,
  initialHtml: string | undefined,
  options?: PopulateOptions,
): UnlayerDesign | null {
  if (initialDesign && typeof initialDesign === "object") {
    return clone(initialDesign as UnlayerDesign);
  }

  const design = clone(newsletterTemplate as UnlayerDesign);

  if (initialMarkdown?.trim()) {
    const parsed = parseMarkdown(initialMarkdown);
    return populateSubstackTemplate(design, parsed, options);
  }

  if (initialHtml?.trim()) {
    // For pre-rendered HTML, just update the date and apply any explicit options
    const today = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    const body = design.body as { rows?: Array<Record<string, unknown>> };
    if (body.rows) {
      for (const row of body.rows) {
        const columns = row.columns as Array<{ contents?: Array<Record<string, unknown>> }> | undefined;
        if (!columns) continue;
        for (const col of columns) {
          const contents = col.contents ?? [];
          for (const content of contents) {
            const id = (content as Record<string, unknown>).id as string | undefined;
            if (id?.includes("text-date")) {
              const values = (content as Record<string, unknown>).values as Record<string, unknown> | undefined;
              if (values) values.text = `<p style="line-height: 140%;">${today.toUpperCase()}</p>`;
            }
          }
        }
      }
    }
    // Apply explicit subject/greeting even when loading from HTML
    if (options?.subject || options?.greeting) {
      return populateSubstackTemplate(design, [], options);
    }
    return design;
  }

  return design;
}