'use strict';

// Multi-line log entries (a request line followed by its JSON payload, a stack
// trace under an error) must reach Loki as ONE entry. The app decides where
// each entry starts and prefixes that line with ENTRY_MARK; Alloy's multiline
// stage glues every unmarked line onto the entry before it, then strips the mark.
const ENTRY_MARK = '\x1e'; // ASCII record separator, never in normal log text

// A line that opens a new entry: it starts with a timestamp, a level, a client
// IP (access logs) or a structured-logger JSON object.
const ENTRY_START_PATTERNS = [
  /^\[?\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}/, // 2026-10-25T14:00, 2026/10/25 14:00, [2026-10-25 14:00
  /^\[?\d{2}\/[A-Z][a-z]{2}\/\d{4}:\d{2}:\d{2}/, // [25/Oct/2026:14:00
  /^[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2}/, // Oct 25 14:00:00 (syslog)
  /^\d{1,3}(?:\.\d{1,3}){3}\s/, // 10.0.0.1 - - [...] (access log)
  /^\[?(?:TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|FATAL|CRITICAL)\b/i,
  /^\{"(?:time|ts|timestamp|@timestamp|level|lvl|msg|message|t)"/, // JSON-lines loggers
];

const isEntryStart = (line) => ENTRY_START_PATTERNS.some((pattern) => pattern.test(line));

// Kubernetes container logs (CRI format) prefix every physical line with
// "<timestamp> <stdout|stderr> <F|P> ". That prefix would make every line look
// like a new entry, so it is removed first; "P" marks a line the runtime split
// (over 16 KB) whose rest follows in the next record.
const CRI_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}) (?:stdout|stderr) ([FP]) (.*)$/;

const unwrapCri = (lines) => {
  const out = [];
  let partial = '';
  for (const line of lines) {
    const match = line.match(CRI_RE);
    if (!match) {
      out.push(partial + line);
      partial = '';
      continue;
    }
    if (match[1] === 'P') {
      partial += match[2];
      continue;
    }
    out.push(partial + match[2]);
    partial = '';
  }
  // A split line whose end is not in this chunk is kept as it is.
  if (partial) out.push(partial);
  return out;
};

// `structured` remembers, per file, whether it has ever shown entry-start
// lines. A file that never does (unknown format) keeps one entry per line,
// so it can't collapse into giant blocks.
const markEntries = (buffer, structured) => {
  if (buffer.length === 0) return { data: buffer, structured };
  const raw = buffer.toString('utf8').split('\n');
  raw.pop(); // buffers hold complete lines only; drop the empty tail after the last "\n"
  const lines = unwrapCri(raw);

  const grouped = structured || lines.some(isEntryStart);
  // Unmarked lines at the top of a chunk continue the entry from the previous poll.
  const marked = lines.map((line) => (!grouped || isEntryStart(line) ? ENTRY_MARK + line : line));
  return { data: Buffer.from(`${marked.join('\n')}\n`, 'utf8'), structured: grouped };
};

module.exports = { markEntries, isEntryStart, ENTRY_MARK };
