# Security policy

## Scope

RepoDNA is a static client-side application. It does not accept repository write permissions, store GitHub tokens, or operate a server-side data store in the reference deployment.

## Reporting a vulnerability

Please do not open a public issue for a suspected security vulnerability. Contact the maintainers privately through the security contact configured for the deployment or repository, and include:

- a concise description and impact
- reproduction steps or a proof of concept
- affected browser, URL, or commit
- a suggested mitigation, if available

Do not include credentials, private repository content, or personal data in a report.

## Security design notes

- User input is validated before API construction.
- API responses are escaped before insertion into HTML. SVG labels are escaped before serialization.
- No GitHub OAuth flow is present.
- Only public GitHub and raw content endpoints are used.
- Manifest content is clipped before parsing and is treated as untrusted text.
- External links use `rel="noreferrer"` where appropriate.

## Supported versions

The latest default branch is the supported version. Please update to the latest commit before reporting a fixed vulnerability.
