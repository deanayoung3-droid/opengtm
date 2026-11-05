Put files here that the app should read, such as a lead list to import. This folder is visible inside the
app container as `data/`, so `./gtm import-leads data/leads.csv --source my-list --terms-ok` works.
Lead lists hold other people's personal data: keep them out of git (everything here except this file is ignored).
