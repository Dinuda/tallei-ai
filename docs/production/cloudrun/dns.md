# Domains and DNS

This deployment uses:

- `tallei.com` -> `tallei-dashboard`
- `api.tallei.com` -> `tallei-backend`

## 1) Create/Inspect Mappings

```bash
gcloud beta run domain-mappings describe \
  --project actionlog-487112 \
  --region us-central1 \
  --domain tallei.com

gcloud beta run domain-mappings describe \
  --project actionlog-487112 \
  --region us-central1 \
  --domain api.tallei.com
```

## 2) DNS Records Required

For `tallei.com` apex:

- `A 216.239.32.21`
- `A 216.239.34.21`
- `A 216.239.36.21`
- `A 216.239.38.21`
- `AAAA 2001:4860:4802:32::15`
- `AAAA 2001:4860:4802:34::15`
- `AAAA 2001:4860:4802:36::15`
- `AAAA 2001:4860:4802:38::15`

For `api.tallei.com`:

- `CNAME api -> ghs.googlehosted.com.`

## 3) GoDaddy Notes

Authoritative nameservers:

- `ns07.domaincontrol.com`
- `ns08.domaincontrol.com`

Add records in GoDaddy DNS Management for `tallei.com`.

If old apex records exist (for previous host), remove them.  
If forwarding is enabled for the root domain, disable forwarding during certificate issuance.

## 4) Validate Propagation

Authoritative checks:

```bash
dig +short @ns07.domaincontrol.com tallei.com A
dig +short @ns08.domaincontrol.com tallei.com A
dig +short @ns07.domaincontrol.com tallei.com AAAA
dig +short @ns08.domaincontrol.com tallei.com AAAA
dig +short @ns07.domaincontrol.com api.tallei.com CNAME
dig +short @ns08.domaincontrol.com api.tallei.com CNAME
```

Public resolver checks:

```bash
dig +short @1.1.1.1 tallei.com A
dig +short @8.8.8.8 tallei.com A
dig +short @1.1.1.1 api.tallei.com CNAME
dig +short @8.8.8.8 api.tallei.com CNAME
```

## 5) Certificate Status

Cloud Run status may remain `CertificatePending` until DNS is visible publicly and challenge checks pass.  
Once DNS is correct everywhere, certificate provisioning typically completes automatically without additional actions.
