import { homedir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluateToolCall } from "../policy.mjs";
import { evaluateBashCommand } from "../policy-bash.mjs";

const HOME = homedir();
const CWD = `${HOME}/Documents/projects/personal/workv3`;

const verdict = (command, options = {}) =>
  evaluateBashCommand(command, { cwd: CWD, scriptTexts: {}, ...options }).verdict;
const tool = (name, input) => evaluateToolCall({ toolName: name, input, cwd: CWD }).verdict;

function assertBlocked(commands) {
  for (const command of commands) assert.equal(verdict(command), "block", command);
}
function assertAllowed(commands) {
  for (const command of commands) assert.equal(verdict(command), "allow", command);
}

test("cron: editing or installing a crontab is refused", () => {
  assertBlocked([
    "crontab -e",
    "crontab mycron",
    "crontab ./jobs.txt",
    "crontab -",
    "crontab -r",
    "crontab -u root -e",
    'echo "* * * * * /tmp/x" | crontab -',
    '(crontab -l; echo "@reboot /tmp/x") | crontab -',
    "sudo crontab -e",
    "sudo -u root crontab mycron",
    "/usr/bin/crontab -e",
    "env EDITOR=vi crontab -e",
  ]);
});

test("cron: listing stays allowed", () => {
  assertAllowed(["crontab -l", "crontab -u root -l", "crontab -l | grep backup", "crontab -V"]);
});

test("launchctl: load, bootstrap, enable and submit are refused", () => {
  assertBlocked([
    "launchctl load ~/Library/LaunchAgents/com.x.plist",
    "launchctl load -w ~/Library/LaunchAgents/com.x.plist",
    "launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.x.plist",
    "launchctl enable gui/501/com.x",
    "launchctl submit -l com.x -- /tmp/x",
    "sudo launchctl load /Library/LaunchDaemons/com.x.plist",
  ]);
});

test("launchctl: read-only subcommands stay allowed", () => {
  assertAllowed([
    "launchctl list",
    "launchctl list com.apple.Finder",
    "launchctl print gui/501",
    "launchctl print gui/501/com.x.enable",
    "launchctl print-disabled gui/501",
    "launchctl blame gui/501/com.x",
  ]);
});

test("systemctl: enable and friends are refused, with or without --user", () => {
  assertBlocked([
    "systemctl enable foo.service",
    "systemctl --user enable foo.service",
    "systemctl enable --now foo.service",
    "systemctl --user --now enable foo.service",
    "systemctl -H host enable foo.service",
    "systemctl reenable foo.service",
    "systemctl link /tmp/foo.service",
    "systemctl preset foo.service",
    "systemctl add-wants default.target foo.service",
    "systemctl edit foo.service",
    "sudo systemctl enable foo.service",
    "/usr/bin/systemctl enable foo.service",
    "loginctl enable-linger matt",
  ]);
});

test("systemctl: inspection stays allowed", () => {
  assertAllowed([
    "systemctl status foo.service",
    "systemctl --user status foo.service",
    "systemctl is-enabled foo.service",
    "systemctl is-active foo.service",
    "systemctl list-units",
    "systemctl list-unit-files",
    "systemctl cat foo.service",
    "systemctl show foo.service",
    "systemctl status enable.service",
    "loginctl show-user matt",
  ]);
});

test("at and batch schedule deferred jobs; listing them is fine", () => {
  assertBlocked([
    "at now + 1 minute",
    "at -f job.sh 10:00",
    'echo "/tmp/x" | at midnight',
    "batch",
  ]);
  assertAllowed(["atq", "at -l", "at -c 12"]);
});

test("writing or copying into launch agent and daemon directories is refused", () => {
  assertBlocked([
    "cp com.x.plist ~/Library/LaunchAgents/",
    "cp com.x.plist ~/Library/LaunchAgents/com.x.plist",
    "cp com.x.plist $HOME/Library/LaunchAgents/",
    "cp com.x.plist /Users/matt/Library/LaunchAgents/",
    "mv com.x.plist /Library/LaunchAgents/",
    "install -m 644 com.x.plist /Library/LaunchDaemons/com.x.plist",
    "cat plist.xml > ~/Library/LaunchAgents/com.x.plist",
    "echo '<plist/>' >> ~/Library/LaunchAgents/com.x.plist",
    "tee ~/Library/LaunchAgents/com.x.plist",
    "ln -s $PWD/com.x.plist ~/Library/LaunchAgents/com.x.plist",
    "cp -t ~/Library/LaunchAgents com.x.plist",
    "cd ~/Library/LaunchAgents && cp /tmp/com.x.plist .",
    "cat > ~/Library/LaunchAgents/com.x.plist <<'EOF'\n<plist/>\nEOF",
    "bash -c 'cp com.x.plist ~/Library/LaunchAgents/'",
  ]);
});

test("writing unit files into systemd directories is refused", () => {
  assertBlocked([
    "cp foo.service ~/.config/systemd/user/",
    "cp foo.service $HOME/.config/systemd/user/foo.service",
    "mkdir -p ~/.config/systemd/user && cp foo.service ~/.config/systemd/user/",
    "cat unit > ~/.config/systemd/user/foo.service",
    "cp foo.service /etc/systemd/system/",
    "install foo.service /usr/lib/systemd/system/foo.service",
    "ln -s $PWD/foo.service ~/.local/share/systemd/user/foo.service",
    "tee /etc/systemd/system/foo.service",
  ]);
});

test("writing into cron directories is refused", () => {
  assertBlocked([
    "cp job /etc/cron.d/job",
    "cp job /etc/cron.daily/job",
    "echo '* * * * * root /tmp/x' >> /etc/crontab",
    "tee /etc/cron.d/job",
    "cp job /var/spool/cron/crontabs/root",
  ]);
});

test("reading persistence locations, and writing look-alikes, stays allowed", () => {
  assertAllowed([
    "ls ~/Library/LaunchAgents",
    "cat ~/Library/LaunchAgents/com.x.plist",
    "cp ~/Library/LaunchAgents/com.x.plist /tmp/backup.plist",
    "ls /etc/cron.d",
    "cat /etc/crontab",
    "ls ~/.config/systemd/user",
    "cat /etc/systemd/system/foo.service",
    "cp com.x.plist dotfiles/Library/LaunchAgents/com.x.plist",
    "cp foo.service packages/systemd/user/foo.service",
    "echo 'systemctl enable foo' > notes.md",
    "grep -r crontab docs",
  ]);
});

test("file tools refuse writes into persistence locations", () => {
  for (const path of [
    "~/Library/LaunchAgents/com.x.plist",
    `${HOME}/Library/LaunchAgents/com.x.plist`,
    "/Library/LaunchDaemons/com.x.plist",
    "~/.config/systemd/user/foo.service",
    "/etc/systemd/system/foo.service",
    "/etc/cron.d/job",
  ]) {
    assert.equal(tool("write", { path, content: "x" }), "block", path);
    assert.equal(tool("edit", { path, edits: [] }), "block", path);
  }
  assert.equal(
    tool("write", { path: "dotfiles/Library/LaunchAgents/x.plist", content: "x" }),
    "allow",
  );
  assert.equal(tool("read", { path: "~/Library/LaunchAgents/com.x.plist" }), "allow");
});

test("a persistence block explains itself", () => {
  const result = evaluateBashCommand("crontab -e", { cwd: CWD, scriptTexts: {} });
  assert.match(result.reason ?? "", /persistence/i);
  const file = evaluateToolCall({
    toolName: "write",
    input: { path: "~/Library/LaunchAgents/com.x.plist" },
    cwd: CWD,
  });
  assert.match(file.reason ?? "", /persistence/i);
});
