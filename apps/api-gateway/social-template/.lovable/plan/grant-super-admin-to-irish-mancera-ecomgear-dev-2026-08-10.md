# Grant super_admin to irish.mancera@SMEsAgent.dev

Add the `super_admin` role alongside the existing `admin` role for user `80ff4cda-7d35-4dd3-83a2-2457fe4c673f`.

## Change

One data insert into `public.user_roles`:

```sql
INSERT INTO public.user_roles (user_id, role)
VALUES ('80ff4cda-7d35-4dd3-83a2-2457fe4c673f', 'super_admin')
ON CONFLICT (user_id, role) DO NOTHING;
```

No schema or code changes. After this, the user sees the Clients section in the admin sidebar and passes all `has_role(auth.uid(), 'super_admin')` policies.
