# Security policy

Alexandria Scoreboard is a development preview. Security fixes are made on the `main` branch; there are no supported binary
releases yet.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on
https://github.com/Coachalex369/alexandria-scoreboard. Do not open a public issue for security problems.

Include what you found, how to reproduce it, and the impact you expect. We aim to acknowledge reports within
7 days.

## Scope notes

- The app runs locally and binds only to `127.0.0.1`; reports about remote exposure of the local server are in scope.
- The Alexandria collector is a Claude Code hook that must never write prompt text, code, command arguments or tool
  output to its log. Any way to make it record such content is a vulnerability.
- Unsigned local builds and Windows Smart App Control behaviour are documented limitations, not vulnerabilities.
