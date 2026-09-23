# Venue template library: notice

The venue list, the style files under `kits/`, the examples under `examples/` and the guides under `guides/` come from [CCFA-Skills](https://github.com/mikubaka88/CCFA-Skills) (`ccf-latex-templates` and `ccf-paper-writer/references/venue-guides`), released under the MIT licence in `LICENSE` beside this file. CCFA-Skills collected the style files from each venue's official kit or publisher repository; each file keeps the licence stated in its own header.

`scripts/build_venues.py` builds this directory from a CCFA-Skills checkout. It reduces the 139 venue folders to 16 kits, copies each venue's own example and guide, and corrects upstream kit mistakes: OSDI takes the USENIX style, IMC the ACM one, and ECOOP, ICALP, ESA, MFCS, ISAAC and CONCUR publish in LIPIcs. The IEEE S&P guide is matched to its folder by name.

Written for this library: each kit's `kit.json` and `main.tex.tmpl`, which let spark-to-paper assemble a paper in the venue's class. The LIPIcs class file is shipped as `lipics-v2021.cls`, the name it declares. `acl_natbib.bst` and ICLR's own bibliography style were not in the upstream folders and are not bundled; the venues that need them say so.
