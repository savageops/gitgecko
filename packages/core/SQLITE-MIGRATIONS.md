# SQLite Migrations

The control, embed, trace, and job-dispatch stores use the shared
`gitgecko_schema_migrations` table with an owner-scoped, ascending version
chain. Existing namespaces and rows are preserved; migrations are additive and
run inside SQLite transactions.

When a file-backed database has pending migrations, startup checkpoints the WAL
and writes a sibling backup before applying the first pending version. A failed
migration rolls back its transaction and leaves the backup intact.

Rollback is deliberately restore-based: stop the service, preserve the failed
database for diagnosis, move the matching
`.backup-<owner>-v<version>-<timestamp>` file back to the configured database
path, then restart on the previous application version. No migration in this
owner performs a destructive rewrite or deletes a customer namespace.
