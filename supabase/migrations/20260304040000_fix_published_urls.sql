-- Migrate existing published_versions: update deployment_url from
-- https://{slug}.ecomgear.app  →  https://preview.ecomgear.app/p/{slug}
UPDATE published_versions
SET deployment_url = 'https://preview.ecomgear.app/p/' || subdomain
WHERE deployment_url LIKE '%.ecomgear.app'
  AND deployment_url NOT LIKE '%preview.ecomgear.app/p/%'
  AND subdomain IS NOT NULL;
