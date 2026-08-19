import { test } from "node:test";
import assert from "node:assert/strict";
import { blockedBashCommand, blockedBashSegment } from "../../../shared/bash-policy.mjs";

test("allows read-only inspection commands", () => {
  for (const cmd of [
    // core inspection
    "ls -la", "cat package.json", "head -50 README.md", "tail -20 logs/server.log",
    "wc -l src/index.ts", "sort -u file.txt", "awk '{print $1}' file.txt",
    "sed -n '1,10p' file", "tr a-z A-Z", "cut -d, -f1 file", "jq '.key' data.json",
    "yq '.a' f.yaml", "xmllint --xpath '//a' f.xml", "diff a b", "comm -3 a b", "cmp a b",
    // search
    "grep -rn plan_mode src", "rg \"TODO\" .", "rg --files", "find src -name '*.ts'",
    "fd -e ts", "locate x", "git grep foo",
    // quoted <>;|&& are literal, not operators
    "grep -n \"<div\" file.html", "echo 'a;b'", "printf '%s; %s\\n' a b", "rg \"a && b\" .",
    "git log --grep=\"fix; bug\"", "echo \"a;rm -rf x\"",
    // navigation / info
    "cd src && ls", "pwd", "which node", "type node", "readlink -f x", "realpath x",
    "dirname x", "basename x", "env", "env | grep PATH", "printenv PATH",
    "uname -a", "whoami", "id -u", "date", "uptime", "ps aux", "top -b -n1",
    "free -h", "stat -f %m file", "du -sh src", "df -h", "tree -L 2", "file x",
    "strings bin", "xxd file", "od -c file", "base64 file", "sha256sum file",
    "lsof -i :8080", "ss -tulpn", "sysctl -a", "test -f file", "echo hi",
    "FOO=1 ls", "ls -la & echo done", "ls -la | head -5", "git log -p | head -50",
    // git read-only
    "git status", "git log -p -3", "git diff HEAD~1", "git show --stat HEAD",
    "git -C src rev-parse HEAD", "git branch -a", "git branch", "git tag -l",
    "git remote -v", "git stash list", "git stash show", "git config --list",
    "git config user.name", "git ls-files", "git ls-tree HEAD", "git fsck",
    "git log --oneline -10 | head -5", "git submodule status", "git worktree list",
    "git --version",
    // package managers: read-only subcommands only
    "npm ls", "npm view typescript version", "npm audit", "npm -v", "npm --version",
    "npm config get registry", "npm config list", "npm ping", "npm whoami",
    "yarn why lodash", "yarn -v", "pnpm list", "bun pm ls", "bun pm cache", "bun --version",
    "cargo metadata --format-version 1", "cargo tree", "cargo -V", "go env GOPATH",
    "go list ./...", "go version",
    // interpreters: version/help only
    "node --version", "node -v", "python3 --version", "python -V", "ruby -v",
    "perl -v", "php -v", "deno --version",
    // archives: list/test/stdout only
    "tar -tf archive.tar.gz", "tar -ztf a.tgz", "unzip -l a.zip", "zipinfo a.zip",
    "gzip -t x.gz", "bzip2 -dc x.bz2", "xz -l x.xz", "zcat x.gz",
  ]) {
    assert.equal(blockedBashCommand(cmd), undefined, `should allow: ${cmd}`);
  }
});

test("blocks mutators outright", () => {
  for (const cmd of [
    "rm -rf node_modules", "mv a b", "cp -r src dst", "touch file", "chmod +x script.sh",
    "sudo whoami", "kill -9 1234", "curl https://example.com -o out.html",
    "vim package.json", "tee out.txt", "make build", "docker build .",
    "shutdown now", "reboot", "launchctl load x", "defaults write com.x y z",
    "osascript -e x", "plutil -replace k v f", "diskutil eraseDisk x", "pbcopy < f",
    "open file", "svn commit", "hg push", "npx tsc", "uv run x", "poetry install",
    "pipx install x", "conda install x", "nvm install 20", "sqlite3 db \"select 1\"",
    "psql -c x", "redis-cli ping", "xargs ls", "watch ls", "rm -rf x & echo done",
  ]) {
    assert.ok(blockedBashCommand(cmd), `should block: ${cmd}`);
  }
});

test("blocks package-manager writes and script execution (fail-closed)", () => {
  for (const cmd of [
    "npm install", "npm i foo", "npm ci", "npm exec tsx", "npm run build", "npm test",
    "npm config set registry x", "yarn", "yarn add x", "pnpm add lodash", "bun add x",
    "bun run dev", "bun test", "bun pm cache clean", "cargo add serde", "cargo run",
    "cargo build", "cargo test", "go get x", "go run main.go", "go test ./...",
    "go build .", "go vet ./...", "go env -w GOPATH=/x",
    "node -e \"console.log(1)\"", "node app.js", "node", "python3 -c \"print(1)\"",
    "python3", "ruby -e 'puts 1'", "perl -e 'print 1'", "php -r 'echo 1;'",
    "deno run x.ts",
  ]) {
    assert.ok(blockedBashCommand(cmd), `should block: ${cmd}`);
  }
});

test("blocks git write subcommands but allows read-only variants", () => {
  for (const cmd of [
    "git commit -m x", "git push origin main", "git checkout -b feature", "git add .",
    "git reset --hard", "git merge main", "git branch foo", "git branch -d foo",
    "git tag v1.0", "git tag -d v1.0", "git remote add origin x", "git remote set-url o u",
    "git config user.name foo", "git config --global user.email x@y.z", "git stash",
    "git stash push", "git clone https://x", "git fetch origin", "git pull origin main",
    "git submodule update", "git worktree add ../wt", "git cherry-pick abc", "git gc",
    "git push --force", "git clean -fd",
  ]) {
    assert.ok(blockedBashCommand(cmd), `should block: ${cmd}`);
  }
});

test("blocks dangerous flags on otherwise read-only tools", () => {
  for (const cmd of [
    "sed -i s/x/y/ file", "sed -i.bak s/x/y/ file", "find . -delete",
    "find . -exec rm {} \\;", "tar -xzf a.tgz", "tar -czf out.tgz dir", "tar -xf a.tar",
    "unzip a.zip", "unzip -d out a.zip", "gzip file", "gzip -d file.gz", "bzip2 -d f.bz2",
    "xz -d f.xz", "env -i", "env FOO=1 ls", "sysctl -w vm.swappiness=10",
    "xmllint --output out f.xml",
  ]) {
    assert.ok(blockedBashCommand(cmd), `should block: ${cmd}`);
  }
});

test("blocks redirects and command substitution", () => {
  for (const cmd of [
    "echo hi > file", "ls >> log.txt", "cat < input", "ls 2>&1", "ls &> file",
    "echo \"$(rm -rf x)\"", "echo `rm -rf x`", "ls $(pwd)",
  ]) {
    assert.ok(blockedBashCommand(cmd), `should block: ${cmd}`);
  }
});

test("blocks unknown commands (fail-closed)", () => {
  for (const cmd of [
    "somecommand --flag", "timeout 5 ls", "command -v ls", "gh pr list", "aws s3 ls",
    "openssl x509 -in cert.pem -text -noout", "source ~/.profile", "zsh",
    "git worktree add x", "svn status",
  ]) {
    assert.ok(blockedBashCommand(cmd), `should block: ${cmd}`);
  }
});

test("blocks a chain when any segment is unsafe", () => {
  assert.equal(blockedBashCommand("cd src && ls"), undefined);
  assert.equal(blockedBashCommand("git log -p | head -50"), undefined);
  assert.ok(blockedBashCommand("cd src && rm -rf out"));
  assert.ok(blockedBashCommand("npm test && git push"));
  assert.ok(blockedBashCommand("ls -la; touch x"));
  assert.ok(blockedBashCommand("cat file | sudo tee out"));
});

test("allows plain sort/shuf/find without file-writing output primaries", () => {
  for (const cmd of ["sort file", "sort -u file.txt", "shuf file", "find . -name x"]) {
    assert.equal(blockedBashCommand(cmd), undefined, `should allow: ${cmd}`);
  }
});

test("blocks sort/shuf -o and find's file-writing output primaries", () => {
  for (const cmd of [
    "sort -o out.txt file", "sort --output=out.txt file", "sort -oout.txt file",
    "shuf -o out.txt file", "shuf --output=out.txt file",
    "find . -fprint out.txt", "find . -fprintf out.txt '%p\\n'", "find . -fls out.txt",
  ]) {
    assert.ok(blockedBashCommand(cmd), `should block: ${cmd}`);
  }
});

test("empty and whitespace input is allowed", () => {
  assert.equal(blockedBashCommand(""), undefined);
  assert.equal(blockedBashSegment("   "), undefined);
  assert.equal(blockedBashCommand(undefined), undefined);
});
