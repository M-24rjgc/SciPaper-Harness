#!/usr/bin/env python3
"""Build the venue template library the platform ships from a CCFA-Skills checkout.

    python build_venues.py <CCFA-Skills checkout> <runtime/venues>

Reads ccf-latex-templates/ (one folder per venue) and ccf-paper-writer/references/venue-guides/
(one guide per venue plus index.md). Writes, under runtime/venues/:

  kits/<kit>/      the kit's official style files, copied beside the hand-written kit.json and
                   main.tex.tmpl already there (this script never touches those two);
  examples/<id>/   a venue's own example sources when its folder has more than its kit;
  guides/<id>.md   the venue guide;
  venues.json      one entry per venue: kit, family, CCF tier, anonymity, links;
  LICENSE          CCFA-Skills' MIT licence.

The 139 CCFA folders hold 22 distinct contents; they reduce to the kits below. Folders whose kit
was wrong upstream are corrected here: OSDI uses the USENIX style, IMC the ACM one, and ECOOP,
ICALP, ESA, MFCS, ISAAC and CONCUR publish in LIPIcs. Standard library only; offline tooling.
"""
from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path

# Which CCFA folders each kit covers.
KIT_OF = {
    "acmart": "ACM ACM-MM ASE ASPLOS CCS CHI CIKM CoNEXT CSCW DAC EuroSys FSE HotNets HPDC ICFP ICPP ICS ICSE IMC ISCA ISSTA MICRO "
              "MobiCom MobiHoc MobiSys OOPSLA PLDI PODS POPL PPoPP SenSys SIGCOMM SIGGRAPH SIGIR SIGKDD SIGMETRICS SIGMOD SoCC SOSP STOC "
              "UbiComp UIST VEE VLDB WSDM WWW",
    "ieeetran": "BIBM CCC CLUSTER DATE FOCS GLOBECOM HPCA ICASSP ICC ICCAD ICCD ICDAR ICDCS ICDE ICDM ICIP ICME ICNP ICPR ICRA IEEE INFOCOM "
                "IPDPS IROS ISCAS ISCC LCN LICS MSST NDSS PERCOM RTAS RTSS S&P SC SECON VR WCNC",
    "llncs": "ASIACRYPT CADE CAV CHES CRYPTO DASFAA ECML-PKDD ESORICS Euro-Par EUROCRYPT FM ICTAC IPCO ISMB MICCAI PAKDD PKC RAID RECOMB "
             "SAS Springer TCC VMCAI WINE WISE",
    "usenix": "FAST HotStorage LISA NSDI OSDI USENIX USENIX-ATC USENIX-Security",
    "acl": "ACL COLING CoNLL EMNLP NAACL",
    "lipics": "LIPIcs CONCUR ECOOP ESA ICALP ISAAC MFCS",
    "aaai": "AAAI", "cvpr": "CVPR", "iccv": "ICCV", "eccv": "ECCV", "iclr": "ICLR", "icml": "ICML", "ijcai": "IJCAI",
    "neurips": "NeurIPS", "siam": "SIAM", "socg": "SoCG",
}
# acmart venues published in a PACM journal take the single-column acmsmall format.
ACMSMALL = {"PLDI", "POPL", "OOPSLA", "ICFP", "CSCW", "UbiComp"}
# Guides the index does not link to their template folder.
GUIDE_ALIASES = {"S&P": "ieee-sp.md"}
# Folders whose upstream kit was wrong.
CORRECTED = {"OSDI", "IMC", "ECOOP", "ICALP", "ESA", "MFCS", "ISAAC", "CONCUR"}
# Folders that are a publisher's base template rather than one venue.
PUBLISHERS = {"ACM": "ACM (acmart)", "IEEE": "IEEE (IEEEtran)", "Springer": "Springer LNCS", "USENIX": "USENIX",
              "LIPIcs": "LIPIcs (Dagstuhl)", "SIAM": "SIAM"}
# Example sources worth keeping per venue: files beyond the kit's style files.
EXAMPLE_SUFFIXES = {".tex", ".bib"}
SKIP_EXAMPLES = {"sample-base.bib", "abbrev.bib", "software.bib", "sample.bib", "sample-franklin.png"}


def slug(folder: str) -> str:
    return {"S&P": "sp"}.get(folder, re.sub(r"[^a-z0-9]+", "-", folder.lower()).strip("-"))


def parse_index(index: Path) -> dict:
    """Guide index rows by guide file name."""
    rows = {}
    for line in index.read_text(encoding="utf-8").splitlines():
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        match = re.match(r"\[(.+?)\]\(\./(.+?\.md)\)", cells[0]) if len(cells) >= 8 else None
        if not match:
            continue
        rows[match.group(2)] = {
            "name": match.group(1).replace(" Writing Guide", ""), "family": cells[1], "tier": cells[2], "template": cells[3],
            "url": cells[4], "summary": cells[5], "verified": cells[6],
        }
    return rows


def main(argv):
    if len(argv) != 2:
        print(__doc__)
        return 2
    ccfa, out = Path(argv[0]), Path(argv[1])
    templates = ccfa / "ccf-latex-templates"
    guides = ccfa / "ccf-paper-writer" / "references" / "venue-guides"
    index = parse_index(guides / "index.md")
    guide_of_template = {}
    for guide, row in index.items():
        match = re.search(r"ccf-latex-templates/([^/`]+)", row["template"])
        if match:
            guide_of_template.setdefault(match.group(1), guide)

    kits = {}
    for kit_dir in sorted((out / "kits").iterdir()):
        kit = json.loads((kit_dir / "kit.json").read_text(encoding="utf-8"))
        kits[kit["id"]] = kit
        for name in kit["files"]:
            shutil.copy2(templates / kit["from"] / name, kit_dir / kit["rename"].get(name, name))
        for folder, files in kit["extra"].items():
            for source, target in files.items():
                shutil.copy2(templates / folder / source, kit_dir / target)
    for stale in ("examples", "guides"):
        shutil.rmtree(out / stale, ignore_errors=True)
    (out / "guides").mkdir(parents=True)

    folders = {name for names in KIT_OF.values() for name in names.split()}
    present = {p.name for p in templates.iterdir() if p.is_dir()}
    assert folders == present, (sorted(present - folders), sorted(folders - present))
    venues = []
    stored = {}
    for kit_id, names in KIT_OF.items():
        kit = kits[kit_id]
        kit_files = set(kit["files"]) | {target for files in kit["extra"].values() for target in files.values()}
        for folder in names.split():
            venue_id = slug(folder)
            guide = GUIDE_ALIASES.get(folder) or guide_of_template.get(folder) or (f"{venue_id}.md" if (guides / f"{venue_id}.md").exists() else None)
            row = index.get(guide, {}) if guide else {}
            if guide:
                shutil.copy2(guides / guide, out / "guides" / f"{venue_id}.md")
            summary = row.get("summary", "")
            anonymous = False if re.search(r"non-blind|single-blind", summary, re.I) else bool(re.search(r"double-blind|anonym", summary, re.I))
            examples = [f for f in sorted((templates / folder).rglob("*")) if f.is_file() and f.name not in kit_files and f.name not in SKIP_EXAMPLES
                        and (f.suffix in EXAMPLE_SUFFIXES or f.parent != templates / folder)]
            # A venue whose kit was corrected keeps none of its upstream folder; identical examples are stored once.
            if folder in PUBLISHERS or folder in CORRECTED:
                examples = []
            signature = tuple((f.relative_to(templates / folder).as_posix(), f.read_bytes()) for f in examples)
            example_dir = stored.get(signature)
            if examples and example_dir is None:
                example_dir = stored[signature] = f"examples/{venue_id}"
                for f in examples:
                    target = out / example_dir / f.relative_to(templates / folder)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(f, target)
            tier = row.get("tier", "")
            entry = {
                "id": venue_id,
                "name": PUBLISHERS.get(folder) or row.get("name") or folder,
                "family": "Publisher" if folder in PUBLISHERS else (row.get("family") if row.get("family") not in (None, "", "TBD") else None),
                "tier": tier if tier.startswith("CCF-") else None,
                "kit": kit_id,
                "anonymous": anonymous,
                "url": row.get("url") if str(row.get("url", "")).startswith("http") else None,
                "guide": f"{venue_id}.md" if guide else None,
                "example": example_dir,
                "verified": row.get("verified") or None,
                "notes": [],
            }
            if kit_id == "acmart" and folder in ACMSMALL:
                entry["classOptions"] = {"review": "acmsmall,screen,review,anonymous", "final": "acmsmall,screen"}
                entry["notes"].append("Published in a PACM journal: single-column acmsmall format")
            if folder in CORRECTED:
                entry["notes"].append(f"Kit corrected from the upstream mapping to {kit['name']}")
            entry["notes"] += [f"Not bundled: {item}; get it from the venue's official kit" for item in kit["missing"]] + kit["notes"]
            if entry["verified"] and not entry["verified"].startswith("Verified"):
                entry["notes"].append("The guide predates this year's call for papers: check page limits and anonymity there")
            venues.append(entry)
    venues.sort(key=lambda v: v["id"])
    (out / "venues.json").write_text(json.dumps({"version": 1, "source": "CCFA-Skills ccf-latex-templates and venue guides (MIT)", "venues": venues},
                                                indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    shutil.copy2(ccfa / "LICENSE", out / "LICENSE")
    print(json.dumps({"venues": len(venues), "kits": len(kits), "guides": len(list((out / "guides").iterdir())),
                      "examples": len(list((out / "examples").iterdir())) if (out / "examples").exists() else 0}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
