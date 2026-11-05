# Unit suites run with bun; the end-to-end run drives real Pi in RPC mode.
# PI_AGENT_MAIL_TEST_BIN names an agent-mail 2.3 program for the integration
# and end-to-end checks; PI_MCP_ADAPTER names pi-mcp-adapter's index.ts.
.PHONY: test e2e check

test:
	bun test test

e2e:
	python3 test/e2e/run.py

check: test e2e
