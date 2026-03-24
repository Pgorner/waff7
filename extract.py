#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Extrahiert Fragen + Antworten aus dem PDF:
"Fragenkatalog für die Sachkundeprüfung (gemäß § 7 WaffG)"

Ausgabe:
- sachkunde_questions.json
- sachkunde_questions.csv

Abhängigkeit:
    pip install pymupdf

Aufruf:
    python extract_sachkunde_pdf.py "Fragenkatalog_sachkunde_mitAntworten.pdf"

Optional:
    python extract_sachkunde_pdf.py input.pdf --json out.json --csv out.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import fitz  # PyMuPDF


QUESTION_ID_RE = re.compile(r"^\d+\.\d+$")
OPTION_LABEL_RE = re.compile(r"^([a-z])\)$", re.IGNORECASE)


# -----------------------------
# Datenklassen
# -----------------------------

@dataclass
class Word:
    x0: float
    y0: float
    x1: float
    y1: float
    text: str


@dataclass
class Line:
    y0: float
    y1: float
    words: List[Word] = field(default_factory=list)

    @property
    def text(self) -> str:
        return join_words(self.words)

    @property
    def x0(self) -> float:
        return min(w.x0 for w in self.words) if self.words else 0.0

    @property
    def x1(self) -> float:
        return max(w.x1 for w in self.words) if self.words else 0.0


@dataclass
class Checkbox:
    y_center: float
    checked: bool
    rect: Tuple[float, float, float, float]


@dataclass
class QuestionRegion:
    qid: str
    page_number: int
    y_start: float
    y_end: float


# -----------------------------
# Hilfsfunktionen Text
# -----------------------------

def normalize_ws(text: str) -> str:
    text = text.replace("\u00ad", "")  # soft hyphen
    text = text.replace("\xa0", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\s+\n", "\n", text)
    text = re.sub(r"\n\s+", "\n", text)
    return text.strip()


def join_words(words: List[Word]) -> str:
    if not words:
        return ""
    words = sorted(words, key=lambda w: (w.x0, w.y0))
    parts = [words[0].text]
    for prev, curr in zip(words, words[1:]):
        gap = curr.x0 - prev.x1

        # Keine Leerstelle vor Satzzeichen
        if curr.text in {".", ",", ";", ":", "!", "?", ")", "]"}:
            parts.append(curr.text)
            continue

        # Keine Leerstelle nach öffnender Klammer
        if prev.text in {"(", "[", "„", '"', "'"}:
            parts.append(curr.text)
            continue

        # typische Worttrennung mit Bindestrich am Zeilenende wird später pro Block bereinigt
        if gap < 1.2:
            parts.append(curr.text)
        else:
            parts.append(" " + curr.text)
    return "".join(parts).strip()


def merge_lines_to_text(lines: List[Line]) -> str:
    if not lines:
        return ""

    lines = sorted(lines, key=lambda ln: (ln.y0, ln.x0))
    out: List[str] = []
    prev_text = ""

    for ln in lines:
        t = ln.text.strip()
        if not t:
            continue

        # Zeilentrennung mit Bindestrich am Ende der Vorzeile reparieren
        if out and out[-1].endswith("-"):
            out[-1] = out[-1][:-1] + t
        else:
            out.append(t)

        prev_text = t

    text = "\n".join(out)

    # Für Fließtext lieber Zeilen in Absätze zurückführen
    text = re.sub(r"(?<!\n)\n(?!\n)", " ", text)
    text = normalize_ws(text)
    return text


# -----------------------------
# Geometrie / Seitenanalyse
# -----------------------------

def extract_words(page: fitz.Page) -> List[Word]:
    raw = page.get_text("words")
    words: List[Word] = []
    for x0, y0, x1, y1, text, *_ in raw:
        if not text.strip():
            continue
        words.append(Word(float(x0), float(y0), float(x1), float(y1), text.strip()))
    return words


def group_words_into_lines(words: List[Word], y_tol: float = 2.5) -> List[Line]:
    if not words:
        return []

    words = sorted(words, key=lambda w: (w.y0, w.x0))
    lines: List[Line] = []

    for w in words:
        placed = False
        for ln in lines:
            if abs(w.y0 - ln.y0) <= y_tol:
                ln.words.append(w)
                ln.y0 = min(ln.y0, w.y0)
                ln.y1 = max(ln.y1, w.y1)
                placed = True
                break
        if not placed:
            lines.append(Line(y0=w.y0, y1=w.y1, words=[w]))

    for ln in lines:
        ln.words.sort(key=lambda w: w.x0)

    lines.sort(key=lambda ln: (ln.y0, ln.x0))
    return lines


def find_question_starts(words: List[Word]) -> List[Tuple[str, float]]:
    """
    Frageschlüssel stehen links und sehen aus wie 1.01 / 2.41 / ...
    """
    candidates = []
    for w in words:
        if w.x0 < 110 and QUESTION_ID_RE.match(w.text):
            # Kopfzeile nicht mitnehmen
            if w.y0 > 80:
                candidates.append((w.text, w.y0))

    # doppelte Fundstellen bereinigen
    out: List[Tuple[str, float]] = []
    seen = set()
    for qid, y in sorted(candidates, key=lambda t: t[1]):
        key = (qid, round(y, 1))
        if key in seen:
            continue
        seen.add(key)
        out.append((qid, y))
    return out


def detect_checkboxes(page: fitz.Page) -> List[Checkbox]:
    """
    Erkennt Kästchen rechts neben MC-Antworten.
    Im PDF ist ein angekreuztes Kästchen als:
    - 1 Rechteck
    - 2 diagonale Linien
    gezeichnet.
    Ein leeres Kästchen enthält nur das Rechteck.
    """
    drawings = page.get_drawings()

    boxes: Dict[Tuple[int, int], Dict[str, Any]] = {}

    def box_key(rect: fitz.Rect) -> Tuple[int, int]:
        cy = int(round((rect.y0 + rect.y1) / 2))
        cx = int(round((rect.x0 + rect.x1) / 2))
        return (cx, cy)

    for d in drawings:
        rect = d.get("rect")
        items = d.get("items", [])
        if rect is None:
            continue

        # typische Größe der Antwortkästchen
        if not (8 <= rect.width <= 14 and 8 <= rect.height <= 14):
            continue

        if rect.x0 < 480:
            continue

        key = box_key(rect)
        entry = boxes.setdefault(
            key,
            {
                "rect": rect,
                "has_rect": False,
                "diag_count": 0,
            },
        )

        for item in items:
            kind = item[0]
            if kind == "re":
                entry["has_rect"] = True
            elif kind == "l":
                p1, p2 = item[1], item[2]
                # diagonal?
                dx = abs(p2.x - p1.x)
                dy = abs(p2.y - p1.y)
                if dx > 5 and dy > 5:
                    entry["diag_count"] += 1

    out: List[Checkbox] = []
    for entry in boxes.values():
        rect = entry["rect"]
        checked = entry["has_rect"] and entry["diag_count"] >= 2
        if entry["has_rect"]:
            out.append(
                Checkbox(
                    y_center=(rect.y0 + rect.y1) / 2,
                    checked=checked,
                    rect=(rect.x0, rect.y0, rect.x1, rect.y1),
                )
            )

    out.sort(key=lambda cb: cb.y_center)
    return out


def nearest_checkbox_for_y(checkboxes: List[Checkbox], y: float, max_dist: float = 10.0) -> Optional[Checkbox]:
    best = None
    best_dist = None
    for cb in checkboxes:
        dist = abs(cb.y_center - y)
        if dist <= max_dist and (best_dist is None or dist < best_dist):
            best = cb
            best_dist = dist
    return best


# -----------------------------
# Kapitel / Abschnitt
# -----------------------------

def extract_header_meta(page: fitz.Page) -> Tuple[str, str]:
    """
    Liest die Seitenüberschrift grob aus.
    Beispiele:
      Kapitel I. Waffenrecht und sonstige Rechtsvorschriften
      1. Begriffe des Waffenrechts
    """
    words = extract_words(page)
    header_words = [w for w in words if w.y0 < 80]
    lines = group_words_into_lines(header_words)

    texts = [ln.text for ln in lines if ln.text.strip()]
    chapter = ""
    section = ""

    # einfache Heuristik
    for t in texts:
        tt = normalize_ws(t)
        if tt.startswith("Kapitel"):
            chapter = tt
        elif re.match(r"^\d+\.\s", tt):
            section = tt

    return chapter, section


# -----------------------------
# Parsing pro Frage
# -----------------------------

def extract_question_regions(doc: fitz.Document) -> List[QuestionRegion]:
    regions: List[QuestionRegion] = []

    for page_index in range(len(doc)):
        page = doc[page_index]
        words = extract_words(page)
        starts = find_question_starts(words)
        if not starts:
            continue

        # Bereich bis zur nächsten Frage auf derselben Seite
        for i, (qid, y_start) in enumerate(starts):
            if i + 1 < len(starts):
                y_end = starts[i + 1][1] - 2
            else:
                y_end = page.rect.height - 15
            regions.append(
                QuestionRegion(
                    qid=qid,
                    page_number=page_index + 1,
                    y_start=y_start - 3,
                    y_end=y_end,
                )
            )
    return regions


def split_question_answer_words(region_words: List[Word]) -> Tuple[List[Word], List[Word]]:
    """
    Linke Spalte = Frage
    Rechte Spalte = Antworten/Optionen
    """
    q_words: List[Word] = []
    a_words: List[Word] = []

    for w in region_words:
        # Fragennummer selbst ignorieren
        if QUESTION_ID_RE.match(w.text):
            continue

        # linke / rechte Spalte
        if w.x0 < 292:
            q_words.append(w)
        else:
            a_words.append(w)

    return q_words, a_words


def remove_leading_question_label(text: str) -> str:
    return re.sub(r"^\d+\.\d+\s*", "", text).strip()


def parse_options(answer_lines: List[Line], checkboxes: List[Checkbox]) -> List[Dict[str, Any]]:
    """
    Erwartet Linien in der rechten Spalte.
    Jede Option beginnt mit a), b), c) ...
    Mehrzeilige Optionen werden an die zuletzt offene Option angehängt.
    """
    options: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None

    for ln in sorted(answer_lines, key=lambda x: x.y0):
        if not ln.words:
            continue

        first = ln.words[0].text
        m = OPTION_LABEL_RE.match(first)

        if m:
            key = m.group(1).lower()
            option_words = ln.words[1:]
            text = join_words(option_words).strip()

            cb = nearest_checkbox_for_y(checkboxes, (ln.y0 + ln.y1) / 2)
            correct = bool(cb.checked) if cb else False

            current = {
                "key": key,
                "text": text,
                "correct": correct,
                "_y0": ln.y0,
            }
            options.append(current)
        else:
            if current is not None:
                extra = join_words(ln.words).strip()
                if extra:
                    if current["text"].endswith("-"):
                        current["text"] = current["text"][:-1] + extra
                    else:
                        current["text"] += " " + extra

    for opt in options:
        opt["text"] = normalize_ws(opt["text"])
        opt.pop("_y0", None)

    return options


def parse_question(page: fitz.Page, region: QuestionRegion, chapter: str, section: str) -> Dict[str, Any]:
    words = extract_words(page)
    region_words = [
        w for w in words
        if region.y_start <= w.y0 <= region.y_end
        and w.y0 > 80  # Kopf ignorieren
    ]

    q_words, a_words = split_question_answer_words(region_words)

    question_lines = group_words_into_lines(q_words)
    answer_lines = group_words_into_lines(a_words)
    checkboxes = detect_checkboxes(page)

    prompt = merge_lines_to_text(question_lines)
    prompt = remove_leading_question_label(prompt)

    options = parse_options(answer_lines, checkboxes)

    if options:
        q_type = "multiple_choice"
        answer_text = None
    else:
        q_type = "self_assessment"
        answer_text = merge_lines_to_text(answer_lines)

    return {
        "id": region.qid,
        "chapter": chapter,
        "section": section,
        "page": region.page_number,
        "type": q_type,
        "prompt": prompt,
        "options": options,
        "answer_text": answer_text,
    }


# -----------------------------
# Validierung / Export
# -----------------------------

def postprocess_questions(questions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    cleaned: List[Dict[str, Any]] = []

    for q in questions:
        if not q["prompt"]:
            continue

        # Leere Antworten bereinigen
        if q["type"] == "self_assessment":
            q["answer_text"] = normalize_ws(q.get("answer_text") or "")

        # Leere MC-Optionen raus
        if q["type"] == "multiple_choice":
            q["options"] = [opt for opt in q["options"] if opt["text"]]

        cleaned.append(q)

    # nach Frageschlüssel sortieren
    def qsort_key(item: Dict[str, Any]) -> Tuple[int, int]:
        a, b = item["id"].split(".")
        return int(a), int(b)

    cleaned.sort(key=qsort_key)
    return cleaned


def export_json(path: Path, source_pdf: Path, questions: List[Dict[str, Any]]) -> None:
    payload = {
        "source_pdf": source_pdf.name,
        "schema_version": 1,
        "question_count": len(questions),
        "questions": questions,
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def export_csv(path: Path, questions: List[Dict[str, Any]]) -> None:
    with path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.writer(f, delimiter=";")
        writer.writerow([
            "id",
            "chapter",
            "section",
            "page",
            "type",
            "prompt",
            "answer_text",
            "options_json",
        ])
        for q in questions:
            writer.writerow([
                q["id"],
                q["chapter"],
                q["section"],
                q["page"],
                q["type"],
                q["prompt"],
                q.get("answer_text") or "",
                json.dumps(q.get("options", []), ensure_ascii=False),
            ])


# -----------------------------
# Main
# -----------------------------

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf", type=Path, help="Pfad zur PDF-Datei")
    parser.add_argument("--json", dest="json_out", type=Path, default=Path("sachkunde_questions.json"))
    parser.add_argument("--csv", dest="csv_out", type=Path, default=Path("sachkunde_questions.csv"))
    args = parser.parse_args()

    if not args.pdf.exists():
        raise SystemExit(f"PDF nicht gefunden: {args.pdf}")

    doc = fitz.open(args.pdf)

    regions = extract_question_regions(doc)
    questions: List[Dict[str, Any]] = []

    header_cache: Dict[int, Tuple[str, str]] = {}

    for region in regions:
        page_index = region.page_number - 1
        page = doc[page_index]

        if page_index not in header_cache:
            header_cache[page_index] = extract_header_meta(page)

        chapter, section = header_cache[page_index]
        q = parse_question(page, region, chapter, section)
        questions.append(q)

    questions = postprocess_questions(questions)

    export_json(args.json_out, args.pdf, questions)
    export_csv(args.csv_out, questions)

    print(f"Fertig.")
    print(f"Extrahierte Fragen: {len(questions)}")
    print(f"JSON: {args.json_out}")
    print(f"CSV : {args.csv_out}")


if __name__ == "__main__":
    main()