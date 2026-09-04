-- Migrate existing published_versions: update deployment_url from
-- https://{slug}.SMEsAgent.app  →  https://preview.SMEsAgent.app/p/{slug}
UPDATE published_versions
SET deployment_url = 'https://preview.SMEsAgent.app/p/' || subdomain
WHERE deployment_url LIKE '%.SMEsAgent.app'
  AND deployment_url NOT LIKE '%preview.SMEsAgent.app/p/%'
  AND subdomain IS NOT NULL;
