# Cloudflare deployment

Configured November 1, 2026 at the user's request for public access from a Mac or any other device.

## Running infrastructure

- Hostname: `notebook.zh-thomas.party`.
- DNS: proxied CNAME to the existing `spark` Cloudflare tunnel, created with `cloudflared tunnel route dns`.
- Tunnel ingress: `https://notebook.zh-thomas.party` → `http://127.0.0.1:4310`.
- App: user service `notebook.service`; its source template is `deploy/notebook.service`. Install the template as `~/.config/systemd/user/notebook.service` before using the service commands below. The older v1 unit is inactive and can be disabled.
- Tunnel: existing `cloudflared.service`, restarted after validating the updated ingress configuration.
- Origin: loopback only; no LAN ports or firewall changes were required.
- Browser writes: the app explicitly allows `https://notebook.zh-thomas.party` through `ALLOWED_ORIGINS`; unrelated public origins remain rejected.

The existing tunnel configuration was backed up before adding the notebook ingress. Other ingress entries were preserved. Cloudflare credentials stay outside the repository.

## Remaining public-access setting

The domain has an existing wildcard Cloudflare Access application. An unauthenticated request to the notebook currently returns HTTP 302 to the Access login page. The origin itself returns HTTP 200 and is healthy.

The saved tunnel-management token successfully created the DNS record, but Cloudflare rejected creating an exact-hostname Access exception with HTTP 403, `auth.forbidden`. No existing Access application or policy was changed.

In the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/):

1. Open **Access controls → Applications → Add an application → Self-hosted**.
2. Name it **Notebook public access** and use the exact public hostname **notebook.zh-thomas.party** (subdomain `notebook`, domain `zh-thomas.party`, no path).
3. Add a policy named **Public notebook access** with **Action: Bypass**, **Include: Everyone**.
4. Save the policy and application.

This creates a specific notebook-hostname exception to the broader wildcard login rule. The other applications retain their existing policies. Cloudflare documents the [Bypass / Include Everyone behavior](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/).

Once saved, verify in a private browser window that `https://notebook.zh-thomas.party` opens the notebook without logging in. The public demo shares its fictional student notebooks with everyone who uses it, as requested.

## Service maintenance on Spark

```bash
systemctl --user status notebook.service
journalctl --user -u notebook.service -n 50 --no-pager
```

After updating code or `.env`:

```bash
cd /home/chzheng/collaborative-course-notebook
npm run check
systemctl --user restart notebook.service
```

After editing tunnel ingress, validate before restarting:

```bash
cloudflared tunnel ingress validate
systemctl --user restart cloudflared.service
```

To configure another public hostname, add that exact HTTPS origin to `ALLOWED_ORIGINS` in the service configuration and restart the app. Never commit provider keys or tunnel credentials.
