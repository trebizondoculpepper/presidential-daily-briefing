# Native project compiler (#514, part 2)

Built the separate static native format stage over the existing English clause parser, with the action-projection lexicon kept apart from default-policy meaning. Validates preference/header structure, helper namespaces/arities/call graph, recursion and clause limits, reason placeholders, and variable binding modes for helpers, joins, negation, priority and independently bound witnesses. Emits generated admitted-root queries, action-bound witness queries, exact canonical project/composite hashes and the same clauses for controlled English rendering.

Tests execute generated queries through pinned DataScript, including an unadmitted labeled entity and a failed attempt to rebind the admitted root. This is still static compilation and selected-file loading only: no worker, project activation, queue integration or authority mutation was added. Runtime cardinality/type/resource/output-admission checks remain #515 and surface/config integration #516. Default English compilation uses the unchanged parser path and default policy artifacts remain checked.

The first-slice FIFO review finding was fixed on its own PR #523 before this stage: pre-open non-regular rejection, nonblocking open and descriptor recheck, with a timeout-bounded native FIFO test. The format's native not= erratum merged independently in #521.
