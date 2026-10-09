# Architecture decision records

Each record states the context, the decision, and its consequences. Where a decision differs from the SRS, the record says what was found and why it changed.

| ADR                                                         | Decision                                                                  | Area          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------- | ------------- |
| [0001](0001-topology-single-source-of-truth.md)             | One topology config drives assets, aliases, topics, rules, and simulator  | Platform      |
| [0002](0002-ingest-through-iot-rules.md)                    | Ingest through AWS IoT Core rules with the SiteWise action                | Ingest        |
| [0003](0003-property-aliases-and-contract-versioning.md)    | Address SiteWise properties by alias; version the contract in the topic   | Contract      |
| [0004](0004-device-timestamps.md)                           | Device timestamps, not ingest time (7 days past, 5 minutes future)        | Contract      |
| [0005](0005-disk-spooler-and-qos1.md)                       | Offline buffering with the Greengrass disk spooler and QoS 1              | Edge          |
| [0006](0006-ipc-from-docker-component.md)                   | Simulator as a Docker component that publishes over Greengrass IPC        | Edge          |
| [0007](0007-query-api-as-separate-lambda-services.md)       | Query API as two Lambda services behind one REST API                      | API           |
| [0008](0008-api-keys-and-usage-plan.md)                     | API keys and a usage plan; IAM or JWT in production                       | API           |
| [0009](0009-grafana-instead-of-sitewise-monitor.md)         | Grafana instead of SiteWise Monitor, which is closed to new customers     | Visualization |
| [0010](0010-toolchain-pins.md)                              | Toolchain versions and monorepo wiring (`@etp/source` condition)          | Tooling       |
| [0011](0011-simulator-design-and-image.md)                  | Simulator design and a container image under 250 MB                       | Edge          |
| [0012](0012-sitewise-model-and-ingest-deviations.md)        | SiteWise model and rule IAM details that differ from the SRS and AWS docs | Ingest        |
| [0013](0013-test-doubles-instead-of-aws-sdk-client-mock.md) | Hand-written test doubles instead of aws-sdk-client-mock                  | Testing       |
| [0014](0014-edge-host-and-provisioning.md)                  | Edge host on t2.micro with manual Greengrass provisioning                 | Edge          |
