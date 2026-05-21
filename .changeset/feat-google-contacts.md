---
"@syncdown/connector-google-contacts": minor
"@syncdown/connectors": minor
"@syncdown/core": minor
"@syncdown/renderer-md": minor
"@syncdown/cli": minor
---

Add Google Contacts connector backed by the People API. Syncs name, emails, phones, organizations, addresses, URLs, contact groups, birthdays, biographies, and custom fields into one markdown file per contact under `<outputDir>/google-contacts/<account>/`. Uses People API `syncToken` for incremental syncs and `contactGroups.list` to resolve human-readable group labels. Requires the `contacts.readonly` OAuth scope — existing users will need to re-authorize the shared Google connection to pick up the new scope.
