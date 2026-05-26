import { writeFile } from "node:fs/promises";

const githubToken = process.env.GITHUB_TOKEN || "";

const formatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Rome",
});

const dateOnlyFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeZone: "Europe/Rome",
});

const sources = {
  codex: {
    type: "github",
    repo: "openai/codex",
    originalUrl: "https://github.com/openai/codex/releases/latest",
  },
  claude: {
    type: "claude",
    originalUrl: "https://code.claude.com/docs/en/changelog",
  },
  opencode: {
    type: "github",
    repo: "anomalyco/opencode",
    originalUrl: "https://github.com/sst/opencode/releases/latest",
  },
};

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "User-Agent": "digon-tech-release-notes-watch",
      Accept: "application/json, text/plain, text/html;q=0.9, */*;q=0.8",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} while reading ${url}`);
  }

  return response.text();
}

async function fetchJson(url, options = {}) {
  return JSON.parse(await fetchText(url, options));
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function linkify(value) {
  return value.replace(
    /(https?:\/\/[^\s)]+)/g,
    '<a href="$1" target="_blank" rel="noreferrer">$1</a>',
  );
}

function inlineMarkdown(value) {
  let text = escapeHtml(value);
  text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(
    /\[([^\]]+)]\((https?:\/\/[^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
  );
  return linkify(text);
}

function trimReleaseMarkdown(markdown) {
  const lines = String(markdown || "").replace(/\r/g, "").split("\n");
  const stopIndex = lines.findIndex((line) => {
    const normalized = line.trim().toLowerCase();
    return normalized.includes("full changelog:") || normalized === "## changelog" || normalized === "# changelog";
  });

  return (stopIndex === -1 ? lines : lines.slice(0, stopIndex)).join("\n").trim();
}

function markdownToHtml(markdown) {
  const lines = trimReleaseMarkdown(markdown).split("\n");
  const html = [];
  let inList = false;
  let paragraph = [];

  function flushParagraph() {
    if (paragraph.length) {
      html.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  }

  function closeList() {
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      closeList();
      continue;
    }

    const heading = line.match(/^#{1,5}\s+(.+)$/);
    if (heading) {
      flushParagraph();
      closeList();
      html.push(`<h4>${inlineMarkdown(heading[1])}</h4>`);
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${inlineMarkdown(bullet[1])}</li>`);
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  closeList();
  return html.join("") || '<p class="empty">No notes were published for this release.</p>';
}

async function readGithubRelease(source) {
  const headers = githubToken ? { Authorization: `Bearer ${githubToken}` } : {};
  const data = await fetchJson(`https://api.github.com/repos/${source.repo}/releases/latest`, { headers });

  return {
    version: data.name || data.tag_name,
    publishedAt: data.published_at ? formatter.format(new Date(data.published_at)) : "",
    html: markdownToHtml(data.body || ""),
    originalUrl: source.originalUrl,
  };
}

async function readClaudeRelease(source) {
  const text = await fetchText("https://r.jina.ai/http://r.jina.ai/http://https://code.claude.com/docs/en/changelog");
  const lines = text.replace(/\r/g, "").split("\n").map((line) => line.trim()).filter(Boolean);
  const versionIndex = lines.findIndex((line) => /^v?(\d+\.){2}\d+/.test(line));

  if (versionIndex === -1) {
    throw new Error("Claude changelog format was not recognized");
  }

  const version = lines[versionIndex].replace(/^v/i, "");
  const publishedAt = lines[versionIndex + 1] && /^[A-Z][a-z]+ \d{1,2}, \d{4}$/.test(lines[versionIndex + 1])
    ? lines[versionIndex + 1]
    : "";
  const stopIndex = lines.findIndex((line, index) => index > versionIndex + 1 && /^v?(\d+\.){2}\d+/.test(line));
  const bodyLines = lines
    .slice(versionIndex + (publishedAt ? 2 : 1), stopIndex === -1 ? undefined : stopIndex)
    .filter((line) => !["Added", "Changed", "Fixed"].includes(line))
    .map((line) => line.replace(/^\*\s+/, ""));

  return {
    version,
    publishedAt: publishedAt ? dateOnlyFormatter.format(new Date(`${publishedAt} 12:00:00`)) : "",
    html: bodyLines.length
      ? `<ul>${bodyLines.map((line) => `<li>${inlineMarkdown(line)}</li>`).join("")}</ul>`
      : '<p class="empty">No text notes were found for the latest version.</p>',
    originalUrl: source.originalUrl,
  };
}

const releases = {};

for (const [key, source] of Object.entries(sources)) {
  releases[key] = source.type === "github"
    ? await readGithubRelease(source)
    : await readClaudeRelease(source);
}

await writeFile(
  "releases.json",
  `${JSON.stringify({ generatedAt: new Date().toISOString(), releases }, null, 2)}\n`,
);
