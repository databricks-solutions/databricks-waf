# Intentionally empty

AppKit's analytics plugin and its type generator both scan this directory. It is kept and
kept empty on purpose, and this file exists so the next person to find an empty directory
does not delete it.

The assessment SQL lives in [`../statements`](../statements). It moved there because the
statements are templates: each one carries `{{customer_catalog <column>}}` fragments that
are expanded when the file is loaded, so the text on disk is deliberately not valid SQL.
The analytics plugin validates every `.sql` file under this directory at startup by running
it with `LIMIT 0`, which failed on every templated statement and took the server's HTTP
listener down with it.

Deleting the directory is not the fix either. The type generator calls `readdir` on it
without guarding for absence, so an absent directory raises `ENOENT` and kills the dev
server's listener a few seconds after it reports itself running — which is a worse failure
than the one that prompted the move, because the log says the server started.

So: present, empty, and nothing in the app reads what the generator would have produced
from it. The collector binds its own parameters and parses its own rows. See the header of
`server/collect/sql/queries.ts` for the whole reasoning, and `server/collect/sql/statements.ts`
for why the plugin's `asUser` path is not used either.
