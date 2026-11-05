#!/usr/bin/env python3
"""End-to-end check of pi-agent-mail in real Pi.

Runs Pi in RPC mode with this extension, a faux provider (no network and no
model), and a private mailbox, then checks the status light, a quiet post that
wakes nobody, a wake for direct mail, a receive through the real
pi-mcp-adapter, the bash guard, /mail, and that no doorbell outlives Pi.

Environment:
  PI_AGENT_MAIL_TEST_BIN    agent-mail 2.3 or later, for the full run (required)
  PI_AGENT_MAIL_LEGACY_BIN  agent-mail 2.2.x, for a legacy-mode run (optional)
  PI_MCP_ADAPTER            pi-mcp-adapter's index.ts; without it the receive
                            step is replaced by the faux model saying so
  PI_BIN                    Pi (default: pi on PATH)
  PI_AGENT_MAIL_EXTENSION   the extension entry to load (default: src/index.ts),
                            for example the entry nix-config generates

Every run gets a private HOME, TMPDIR, Pi agent directory and mailbox, made
with agent-mail init; it never touches ~/Mailbox.
"""

import json
import os
from pathlib import Path
from queue import Empty, Queue
import re
import subprocess
import sys
from tempfile import TemporaryDirectory
from threading import Thread
import time

ROOT = Path(__file__).resolve().parents[2]
EXTENSION = Path(os.environ.get("PI_AGENT_MAIL_EXTENSION") or ROOT / "src" / "index.ts")
FAUX = ROOT / "test" / "e2e" / "faux-provider.ts"
PI = os.environ.get("PI_BIN", "pi")
NAME = "testpi"
DEADLINE = 60
ANSI = re.compile(r"\x1b\[[0-9;]*m")
DOORBELL = "watch --doorbell --forever --parent"
CHECKS = 0
EVENTS = 0


def ok(condition, what):
    """One explicit assertion of the run."""
    global CHECKS
    if not condition:
        raise AssertionError(what)
    CHECKS += 1


def clean(event, when=""):
    """Every event Pi prints is also checked: no extension may have failed. Counted apart from ok()."""
    global EVENTS
    if event.get("type") == "extension_error":
        raise AssertionError(f"an extension failed{when}: {event}")
    EVENTS += 1


def doorbells_for(pid):
    """The pids of the doorbells whose parent is PID: `agent-mail watch --doorbell --forever --parent PID`.
    Pi's launcher execs Pi itself, so the pid this harness started is the parent the extension names."""
    result = subprocess.run(["pgrep", "-f", f"{DOORBELL} {pid}$"], capture_output=True, text=True, check=False)
    return set(result.stdout.split())


class Mailbox:
    """A private mailbox and HOME, set up and fed through the agent-mail CLI."""

    def __init__(self, base, program):
        self.base = base
        self.program = program
        for directory in ("home", "tmp", "agent", "project", "mailbox"):
            (base / directory).mkdir(parents=True)
        self.config = base / "agent-mail.json"
        self.config.write_text(json.dumps({"dir": str(base / "mailbox")}))
        self.run("init")
        self.run("channel", "create", "ops", "--purpose", "end-to-end wake channel")
        self.run("channel", "create", "notes", "--purpose", "end-to-end quiet channel")
        self.run("subscribe", NAME, "ops", "--wake")
        self.run("subscribe", NAME, "notes")

    def env(self):
        return {
            "PATH": os.environ["PATH"],
            "HOME": str(self.base / "home"),
            "TMPDIR": str(self.base / "tmp"),
            "AGENT_MAIL_DIR": str(self.base / "mailbox"),
        }

    def run(self, *args, body=None):
        result = subprocess.run(
            [self.program, *args], env=self.env(), input=body, capture_output=True, text=True, timeout=30, check=False
        )
        assert result.returncode == 0, f"agent-mail {' '.join(args)}: {result.returncode} {result.stderr}"
        return result.stdout

    def send(self, to, subject, body):
        self.run("send", "--from", "peer", "--to", to, "--subject", subject, "-", body=body)


def adapter_bootstrap(mailbox, program, adapter):
    """An extension entry that loads the real pi-mcp-adapter serving this agent-mail, alone."""
    env = {
        "PATH": os.environ["PATH"],
        "HOME": str(mailbox.base / "home"),
        "TMPDIR": str(mailbox.base / "tmp"),
        "AGENT_MAIL_CONFIG": str(mailbox.config),
        "AGENT_MAIL_NAME": NAME,
    }
    config = {
        "settings": {"mcpFooterStatus": "off"},
        "mcpServers": {"agent-mail": {"command": program, "args": ["mcp"], "env": env}},
    }
    path = mailbox.base / "mcp-bootstrap.ts"
    path.write_text(
        f"import {{ createMcpAdapter }} from {json.dumps(adapter)};\n"
        f"export default createMcpAdapter({{ config: {json.dumps(config)}, exclusive: true }});\n"
    )
    return path


class Pi:
    """Real Pi in RPC mode; every event it prints is kept in order."""

    def __init__(self, mailbox, program, bootstrap=None):
        self.mailbox = mailbox
        command = [
            PI,
            "--mode",
            "rpc",
            "--offline",
            "--no-session",
            "--no-context-files",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-approve",
            "--extension",
            str(EXTENSION),
            "--extension",
            str(FAUX),
        ]
        if bootstrap is not None:
            command += ["--extension", str(bootstrap)]
        command += ["--provider", "synthetic-mail", "--model", "target"]
        base = mailbox.base
        env = {
            "PATH": os.environ["PATH"],
            "HOME": str(base / "home"),
            "TMPDIR": str(base / "tmp"),
            "PI_CODING_AGENT_DIR": str(base / "agent"),
            "PI_OFFLINE": "1",
            "AGENT_MAIL_CONFIG": str(mailbox.config),
            "AGENT_MAIL_NAME": NAME,
            "PI_AGENT_MAIL_BIN": program,
            "PI_AGENT_MAIL_REFRESH": "10",
        }
        self.stderr = (base / "pi.stderr").open("w+")
        self.process = subprocess.Popen(
            command, cwd=base / "project", env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr
        )
        self.lines = Queue()
        self.events = []
        self.seen = 0
        Thread(target=self._pump, daemon=True).start()

    def _pump(self):
        stdout = self.process.stdout
        assert stdout is not None
        for raw in stdout:
            self.lines.put(raw)
        self.lines.put(None)

    def _diagnostic(self):
        self.stderr.flush()
        self.stderr.seek(0)
        return self.stderr.read()[-4000:]

    def _take(self, deadline):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError
        try:
            return self.lines.get(timeout=remaining)
        except Empty:
            raise TimeoutError from None

    def wait(self, predicate, what, timeout=DEADLINE, advance=True):
        """The first event since the last match that satisfies PREDICATE. With advance false
        (a command's response), the cursor stays put, so events a command's handler printed
        before its response are still found by the next wait."""
        for index in range(self.seen, len(self.events)):
            if predicate(self.events[index]):
                if advance:
                    self.seen = index + 1
                return self.events[index]
        deadline = time.monotonic() + timeout
        while True:
            try:
                raw = self._take(deadline)
            except TimeoutError:
                raise AssertionError(f"no {what} within {timeout}s; Pi said: {self._diagnostic()}") from None
            if raw is None:
                raise AssertionError(f"Pi exited before {what}: {self._diagnostic()}")
            if not raw.strip():
                continue
            event = json.loads(raw)
            clean(event)
            self.events.append(event)
            if predicate(event):
                if advance:
                    self.seen = len(self.events)
                return event

    def request(self, ident, kind, **fields):
        stdin = self.process.stdin
        assert stdin is not None
        stdin.write((json.dumps({"id": ident, "type": kind, **fields}) + "\n").encode())
        stdin.flush()
        response = self.wait(
            lambda e: e.get("type") == "response" and e.get("id") == ident, f"response to {ident}", advance=False
        )
        ok(response.get("success") is True, f"{ident} failed: {response}")
        return response

    def prompt(self, ident, message):
        return self.request(ident, "prompt", message=message)

    def close(self):
        stdin = self.process.stdin
        assert stdin is not None
        stdin.close()
        deadline = time.monotonic() + DEADLINE
        while True:
            try:
                raw = self._take(deadline)
            except TimeoutError:
                raise AssertionError(f"Pi did not exit: {self._diagnostic()}") from None
            if raw is None:
                break
            if raw.strip():
                event = json.loads(raw)
                clean(event, " at shutdown")
                self.events.append(event)
        code = self.process.wait(timeout=DEADLINE)
        self.stderr.close()
        return code


def status(text):
    return lambda e: (
        e.get("type") == "extension_ui_request"
        and e.get("method") == "setStatus"
        and e.get("statusKey") == "agent-mail"
        and ANSI.sub("", e.get("statusText") or "") == text
    )


def notice(fragment):
    return lambda e: e.get("type") == "extension_ui_request" and e.get("method") == "notify" and fragment in (e.get("message") or "")


def custom_wake(e):
    message = e.get("message") or {}
    return e.get("type") == "message_end" and message.get("customType") == "agent-mail" and "peer mail is waiting" in json.dumps(message)


def tool_end(name):
    return lambda e: e.get("type") == "tool_execution_end" and e.get("toolName") == name


def result_text(event):
    content = (event.get("result") or {}).get("content") or []
    return "\n".join(part.get("text", "") for part in content if isinstance(part, dict))


def settled(e):
    return e.get("type") == "agent_settled"


def full_run(program, adapter):
    with TemporaryDirectory() as root:
        mailbox = Mailbox(Path(root), program)
        bootstrap = adapter_bootstrap(mailbox, program, adapter) if adapter else None
        pi = Pi(mailbox, program, bootstrap)
        pid = pi.process.pid
        pi.wait(status(f"✉ {NAME} · +notes · +ops"), "the first status light")
        time.sleep(1)
        ok(len(doorbells_for(pid)) == 1, f"Pi {pid} runs {len(doorbells_for(pid))} doorbells, not one")

        mailbox.send("+notes", "a quiet note", "nothing urgent")
        time.sleep(2.5)  # agent-mail counts a post only once its 2 s settle window has passed
        pi.prompt("mail-1", "/mail")
        pi.wait(notice("+notes: 1 waiting (quiet)"), "/mail showing the quiet post")
        pi.wait(status(f"✉ {NAME} · +notes 1 · +ops"), "the light counting the quiet post")
        ok(not any(e.get("type") == "agent_start" for e in pi.events), "a quiet post started a turn")

        mailbox.send(NAME, "hello", "direct mail for the end-to-end run")
        pi.wait(custom_wake, "the wake notice")
        if adapter:
            end = pi.wait(tool_end("mcp"), "the receive through the adapter")
            ok(end.get("isError") is False, f"receive failed: {result_text(end)}")
            text = result_text(end)
            ok(f"for {NAME}" in text and "direct id=" in text and "from=peer" in text, f"receive delivered nothing: {text[:300]}")
            pi.wait(settled, "the wake turn to settle")
            pi.wait(status(f"✉ {NAME} · +notes · +ops"), "the light after receive")
            ok("no mail for testpi" in mailbox.run("pending", NAME, "--format", "human"), "mail still waits after receive")
        else:
            pi.wait(lambda e: e.get("type") == "message_end" and "no-adapter" in json.dumps(e.get("message")), "the faux reply")
            pi.wait(settled, "the wake turn to settle")

        pi.prompt("guard-1", "guard-check")
        end = pi.wait(tool_end("bash"), "the guarded bash call")
        ok(end.get("isError") is True, "the piped read was not blocked")
        ok("never pipe agent-mail read or watch" in result_text(end), f"the block gave no reason: {result_text(end)}")
        pi.wait(settled, "the guard turn to settle")

        pi.prompt("mail-2", "/mail")
        pi.wait(notice("doorbell: running"), "/mail showing the doorbell")
        ok(any(notice("wakes: on")(e) for e in pi.events), "/mail did not show the wakes")

        ok(pi.close() == 0, "Pi did not exit cleanly")
        time.sleep(1.5)
        ok(not doorbells_for(pid), "a doorbell outlived Pi")


def replacement_run(program):
    """A session replacement (new_session) stops the old runtime's doorbell and starts one new one."""
    with TemporaryDirectory() as root:
        mailbox = Mailbox(Path(root), program)
        pi = Pi(mailbox, program)
        pid = pi.process.pid
        light = status(f"✉ {NAME} · +notes · +ops")
        pi.wait(light, "the light before the replacement")
        time.sleep(1)
        ok(len(doorbells_for(pid)) == 1, f"one doorbell before the replacement, not {len(doorbells_for(pid))}")
        pi.request("new-1", "new_session")
        pi.wait(light, "the light after the replacement")
        time.sleep(1.5)
        ok(len(doorbells_for(pid)) == 1, f"one doorbell after the replacement, not {len(doorbells_for(pid))}")
        mailbox.send(NAME, "after", "direct mail after the replacement")
        pi.wait(custom_wake, "the wake in the new session")
        pi.wait(settled, "the new session's wake turn to settle")
        ok(pi.close() == 0, "Pi did not exit cleanly")
        time.sleep(1.5)
        ok(not doorbells_for(pid), "a doorbell outlived Pi after a replacement")


def legacy_run(program):
    with TemporaryDirectory() as root:
        mailbox = Mailbox(Path(root), program)
        pi = Pi(mailbox, program)
        pid = pi.process.pid
        pi.wait(status("✉"), "the legacy light before any ring")
        mailbox.send(NAME, "hello", "direct mail for the legacy run")
        pi.wait(status(f"✉ {NAME} · 1 direct"), "the legacy light after the ring")
        pi.wait(custom_wake, "the legacy wake notice")
        pi.wait(settled, "the legacy wake turn to settle")
        pi.prompt("mail-1", "/mail")
        pi.wait(notice("agent-mail before 2.3"), "/mail in legacy mode")
        ok(pi.close() == 0, "Pi did not exit cleanly")
        time.sleep(1.5)
        ok(not doorbells_for(pid), "a legacy doorbell outlived Pi")


def main():
    program = os.environ.get("PI_AGENT_MAIL_TEST_BIN")
    if not program:
        sys.exit("e2e: set PI_AGENT_MAIL_TEST_BIN to an agent-mail 2.3 program")
    adapter = os.environ.get("PI_MCP_ADAPTER")
    full_run(program, adapter)
    replacement_run(program)
    legacy = os.environ.get("PI_AGENT_MAIL_LEGACY_BIN")
    if legacy:
        legacy_run(legacy)
    runs = "full" + (" with the adapter" if adapter else " without the adapter") + ", replacement" + (", legacy" if legacy else "")
    print(f"e2e: {CHECKS} assertions passed; {EVENTS} events, none an extension error ({runs})")


if __name__ == "__main__":
    main()
