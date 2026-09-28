# Evaluation definition

The candidate mechanism associates each factual summary statement with supporting source spans. A statement lacking source support is revised or omitted. The baseline uses the same source text, model, summary length budget and decoding settings without this support check.

In a real study, consistency would be the fraction of annotated factual statements supported by the source. The denominator, segmentation rules and treatment of unverifiable statements must be fixed before annotation. Coverage, readability and summary length are complementary outcomes: deleting everything must not be counted as a useful improvement.

Paired source documents control input variation. A blinded annotation protocol and agreement measurements address judgment variation. The mechanism claim needs a support-check ablation. Efficiency requires measured added latency and token cost. The bundled results illustrate the paired consistency comparison only, with synthetic percentages; they contain no coverage, annotator-agreement or efficiency observations.
