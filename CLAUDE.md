# Rules for Claude in this repo

- Before any commit, push or pull request, read the private rules file in Claude's memory (/topics/public-repos.md). If you cannot read it, do not commit, push or open a pull request, and say why, and that this work needs a session that can read that file.
- Never check out, build, run, test or merge a fork, or a pull request whose branch is in a fork (`gh pr view <n> --json isCrossRepository` prints true).
