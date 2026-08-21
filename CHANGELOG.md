# Changelog

## [0.11.0](https://github.com/FullmetalBober/Indexterity/compare/v0.10.1...v0.11.0) (2026-08-20)


### Features

* a regression's score penalty fades instead of lasting forever ([7f25835](https://github.com/FullmetalBober/Indexterity/commit/7f258359d2b2154cb47ec6d6155a290036cc5f64))
* a regression's score penalty fades instead of lasting forever ([b472ff2](https://github.com/FullmetalBober/Indexterity/commit/b472ff2d65d996b3d871ffcb8ed0629957b25674))
* **api:** make builds on one collection compete rather than accumulate ([3dd114e](https://github.com/FullmetalBober/Indexterity/commit/3dd114e0cf80fb1c8e929d4dcd25975751561c24))
* **api:** make builds on one collection compete rather than accumulate ([861d792](https://github.com/FullmetalBober/Indexterity/commit/861d79297fcfd0a1224f5a8066c627ff2a701cda)), closes [#281](https://github.com/FullmetalBober/Indexterity/issues/281)
* **api:** measure a run of builds against where it started ([ea61f34](https://github.com/FullmetalBober/Indexterity/commit/ea61f34c8a00ee997e5caf836f017651dab79b0e))
* **api:** measure a run of builds against where it started ([e710423](https://github.com/FullmetalBober/Indexterity/commit/e71042393ddcbd7fe7e9ed3132780d598f19bf96)), closes [#282](https://github.com/FullmetalBober/Indexterity/issues/282)
* **api:** one live recommendation per index, as a constraint ([f08a9cb](https://github.com/FullmetalBober/Indexterity/commit/f08a9cb5b810d4a6a63fcced6d6440cba6264484))
* **api:** one live recommendation per index, as a constraint ([4b18d6a](https://github.com/FullmetalBober/Indexterity/commit/4b18d6a77417233c406f789e5b842b4a5e232ac5)), closes [#283](https://github.com/FullmetalBober/Indexterity/issues/283)
* **api:** workload analysis is on by default ([d470d5e](https://github.com/FullmetalBober/Indexterity/commit/d470d5e0de4c1bb179424a85fc5b73c6d74be736))
* **api:** workload analysis is on by default ([4c47993](https://github.com/FullmetalBober/Indexterity/commit/4c47993b49f05ef521616cada7c7085173c3535f)), closes [#258](https://github.com/FullmetalBober/Indexterity/issues/258)
* let an owner end a pending drop's observation early ([84c0c36](https://github.com/FullmetalBober/Indexterity/commit/84c0c36b2581bb581eca8a2063d9635b2b936ca2))
* let an owner end a pending drop's observation early ([244bf82](https://github.com/FullmetalBober/Indexterity/commit/244bf82bf0f93b3d3732fa77e4f129cfdd681868)), closes [#270](https://github.com/FullmetalBober/Indexterity/issues/270)
* report which usage-trust check refused, per engine ([95573cb](https://github.com/FullmetalBober/Indexterity/commit/95573cbbf1750c2cd65416edc6adddb4aac6d69a))
* report which usage-trust check refused, per engine ([4918fb3](https://github.com/FullmetalBober/Indexterity/commit/4918fb319ffe66e91fc25010bd005dcff03575e7)), closes [#267](https://github.com/FullmetalBober/Indexterity/issues/267)
* say why the engine had nothing to recommend ([08f010b](https://github.com/FullmetalBober/Indexterity/commit/08f010bbf5fc93bd652d504e4b758877382919ef))
* say why the engine had nothing to recommend ([9a2b1a8](https://github.com/FullmetalBober/Indexterity/commit/9a2b1a8b5ae46d8ff382e2e1305a2b1ff9aaeb03)), closes [#277](https://github.com/FullmetalBober/Indexterity/issues/277)
* show why a pending drop got the observe window it did ([7335316](https://github.com/FullmetalBober/Indexterity/commit/7335316cbd4c907a7847eabbc7a8e4287aca5681))
* show why a pending drop got the observe window it did ([d3b5657](https://github.com/FullmetalBober/Indexterity/commit/d3b56576af7da5eab9f9aac8e7c30eefc01cf935)), closes [#269](https://github.com/FullmetalBober/Indexterity/issues/269)


### Bug Fixes

* **api,web:** refuse an approval a read-only cluster can never act on ([c00525d](https://github.com/FullmetalBober/Indexterity/commit/c00525d76c2dfa213ef924213b5e545f78b428f8))
* **api,web:** refuse an approval a read-only cluster can never act on ([01c289b](https://github.com/FullmetalBober/Indexterity/commit/01c289bab4c38d167f1ef0e1688a3b730eee3cc4)), closes [#257](https://github.com/FullmetalBober/Indexterity/issues/257)
* **api:** read the drained queue once it has settled ([b7913d7](https://github.com/FullmetalBober/Indexterity/commit/b7913d70805e96dfa746ca932855cfbb9ad4b03e))
* **api:** read the drained queue once it has settled ([90c89aa](https://github.com/FullmetalBober/Indexterity/commit/90c89aac2e8a354a14b8cd6034dc243dc318fbbf)), closes [#280](https://github.com/FullmetalBober/Indexterity/issues/280)
* **api:** the build budget reports only what it actually held back ([751511b](https://github.com/FullmetalBober/Indexterity/commit/751511bb42ee73c40b3f33eed6b4ea672f18161d))
* **api:** the build budget reports only what it actually held back ([5c751ce](https://github.com/FullmetalBober/Indexterity/commit/5c751ce47f17c8e0839a6ab2127cb2f9b8eb9a8d))
* classify index usage from activity, not from the counter's value ([4e28672](https://github.com/FullmetalBober/Indexterity/commit/4e28672c1c8a6904953f7d0db5faac45b9696e27))
* classify index usage from activity, not from the counter's value ([f04ed11](https://github.com/FullmetalBober/Indexterity/commit/f04ed1177a70b4d27d155bdb776ec2b3fadd9e66)), closes [#265](https://github.com/FullmetalBober/Indexterity/issues/265)
* read index usage as activity, not as a cumulative counter ([3c4648b](https://github.com/FullmetalBober/Indexterity/commit/3c4648b7693e7ca8ca221354886a2d4459ed2ad5))
* read index usage as activity, not as a cumulative counter ([756a3d1](https://github.com/FullmetalBober/Indexterity/commit/756a3d173f0c7ce6ff30e212a95e52cb4c3d4654)), closes [#263](https://github.com/FullmetalBober/Indexterity/issues/263)
* satisfy noUncheckedIndexedAccess in the usageSeries test ([8b68260](https://github.com/FullmetalBober/Indexterity/commit/8b6826059a3ebcfa7177957b54d8d4c17459766a))
* the shortened window rounds up, and the copy now says so ([e57b88c](https://github.com/FullmetalBober/Indexterity/commit/e57b88c7c35f03af945ecf7b83814ade223ec2ce))
* **web:** a failed read is not an empty panel ([bd3a963](https://github.com/FullmetalBober/Indexterity/commit/bd3a96396d44e259b74b530eb6effdc47780659f))
* **web:** a failed read is not an empty panel ([67575a6](https://github.com/FullmetalBober/Indexterity/commit/67575a67211258f64d427ea7a27f003a976097e6)), closes [#289](https://github.com/FullmetalBober/Indexterity/issues/289)
* **web:** an overdue drop says what it is waiting for, not nothing ([b936817](https://github.com/FullmetalBober/Indexterity/commit/b936817e1c6d1256c3579a28ea08ee6bb87b194d))
* **web:** an overdue drop says what it is waiting for, not nothing ([696213d](https://github.com/FullmetalBober/Indexterity/commit/696213db35a6bcf162e2f8856a7acbbdfbffb2fd)), closes [#268](https://github.com/FullmetalBober/Indexterity/issues/268)
* **web:** the policy card's Save was a fourth field, not the form's action ([d1044ce](https://github.com/FullmetalBober/Indexterity/commit/d1044cea7016f7f71da0d7bec7276d59fcb4b981))
* **web:** the policy card's Save was a fourth field, not the form's action ([fa746f0](https://github.com/FullmetalBober/Indexterity/commit/fa746f07d65c5a2e7dfcd793a2466b291da58108))
* **web:** the second action on a hidden drop was cut, not scrolled ([a3f5098](https://github.com/FullmetalBober/Indexterity/commit/a3f5098aab1e273cb09a7147e2b32469e13c4da1))
* **web:** the second action on a hidden drop was cut, not scrolled ([a8a61e8](https://github.com/FullmetalBober/Indexterity/commit/a8a61e8193b40c6cd28cdc475ac8ddb824523fa2))
