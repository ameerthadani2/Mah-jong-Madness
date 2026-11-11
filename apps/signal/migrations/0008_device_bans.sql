-- 0008_device_bans: a ban covers the banned account's devices.
-- Applied by src/migrate.ts inside one transaction. Never edit a migration that has shipped.

-- The id an app install sends with a guest sign-up becomes the device's id when it is free. When
-- an earlier account on the same install already holds it, the new device gets an id of its own
-- and keeps the install's here, so a ban of either account still finds the phone.
ALTER TABLE devices ADD COLUMN install_id uuid;
CREATE INDEX devices_install_idx ON devices (install_id) WHERE install_id IS NOT NULL;

-- The device ids (and install ids) a banned account covers, written when it is banned and
-- removed when the ban is lifted. No new guest account may be created from one of them (403
-- `banned`). One row per device and banned account, so lifting one ban does not free a device
-- another banned account also used. The rows go with a purge of the account.
CREATE TABLE banned_devices (
  device_id uuid NOT NULL,
  user_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  banned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, user_id)
);
CREATE INDEX banned_devices_user_idx ON banned_devices (user_id);
