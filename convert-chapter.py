#!/usr/bin/env python3
"""Convert pdftotext output of a chapter PDF into the player's TITLE / prose / [LEDGER] format."""
import re
import sys

ROMAN = {'I':1,'II':2,'III':3,'IV':4,'V':5,'VI':6,'VII':7,'VIII':8,'IX':9,'X':10,
         'XI':11,'XII':12,'XIII':13,'XIV':14,'XV':15}

def is_page_number(s):
    t = s.strip()
    return t.isdigit() and len(t) <= 3

def get_indent(line):
    return len(line) - len(line.lstrip())

def normalize(s):
    # Fix common PDF artifacts
    s = re.sub(r'(\w)-\s+(\w)', r'\1\2', s)   # join words split across lines
    s = re.sub(r'\s+', ' ', s).strip()
    return s

def process(text):
    lines = text.split('\n')

    # ---- find chapter title ----
    title = "Untitled"
    body_start = 0
    for i, line in enumerate(lines):
        m = re.match(r'^\s*CHAPTER\s+([IVXLCDM]+)\s*$', line)
        if m:
            # Title is on the next non-empty lines (might wrap across 1-3 lines)
            j = i + 1
            while j < len(lines) and not lines[j].strip():
                j += 1
            title_lines = []
            while j < len(lines) and lines[j].strip() and not lines[j].strip().startswith('---'):
                # Stop if line starts with a sentence-case body word (heuristic: first char is uppercase + has lowercase = title; otherwise body)
                # Better heuristic: stop when we see a blank line after title started
                stripped = lines[j].strip()
                # Title lines are short and Title Case. Body lines are sentences.
                if len(stripped) > 80:
                    break
                # If this looks like a sentence (ends with . or has more than ~12 words), stop
                if stripped.endswith('.') or stripped.endswith('!') or stripped.endswith('?'):
                    if len(stripped.split()) > 6:
                        break
                title_lines.append(stripped)
                j += 1
                if j < len(lines) and not lines[j].strip():
                    # Title done at blank line
                    break
            title = ' '.join(title_lines).strip()
            body_start = j
            break

    # ---- process body ----
    body = lines[body_start:]
    # Strip page numbers
    body = [l for l in body if not is_page_number(l)]

    # Group into paragraphs (blank-line separated)
    paragraphs = []
    cur = []
    for line in body:
        if not line.strip():
            if cur:
                paragraphs.append(cur)
                cur = []
        else:
            cur.append(line)
    if cur:
        paragraphs.append(cur)

    # Determine baseline indent for prose vs ledger
    indents = []
    for para in paragraphs:
        for l in para:
            indents.append(get_indent(l))
    base_indent = min(indents) if indents else 0

    # Merge paragraphs split by page-number stripping:
    # if a paragraph doesn't end with sentence-ending punct and the next
    # starts with a lowercase letter, glue them together.
    SENT_END = ('.', '!', '?', '"', '”', '—', '–', ':', ';', ')')
    merged = []
    for para in paragraphs:
        if merged:
            prev_last = merged[-1][-1].rstrip()
            this_first = para[0].lstrip()
            if (prev_last and not prev_last.endswith(SENT_END)
                    and this_first and this_first[0].islower()):
                # same indent class? if so, merge
                if abs(get_indent(merged[-1][-1]) - get_indent(para[0])) <= 2:
                    merged[-1].extend(para)
                    continue
        merged.append(para)
    paragraphs = merged

    out = [f"TITLE: {title}", ""]
    ledger_buf = []
    for para in paragraphs:
        para_indents = [get_indent(l) for l in para]
        min_indent = min(para_indents)
        is_ledger = min_indent > base_indent + 1

        joined = normalize(' '.join(para))

        if is_ledger:
            ledger_buf.append(joined)
        else:
            if ledger_buf:
                out.append('[LEDGER]')
                out.extend(ledger_buf)
                out.append('[/LEDGER]')
                out.append('')
                ledger_buf = []
            out.append(joined)
            out.append('')

    if ledger_buf:
        out.append('[LEDGER]')
        out.extend(ledger_buf)
        out.append('[/LEDGER]')
        out.append('')

    return '\n'.join(out).rstrip() + '\n'

if __name__ == '__main__':
    text = sys.stdin.read()
    sys.stdout.write(process(text))
