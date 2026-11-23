CREATE TABLE IF NOT EXISTS account (
  uin INTEGER PRIMARY KEY CHECK (uin BETWEEN 1 AND 4294967295),
  qq_name TEXT NOT NULL CHECK (length(qq_name) BETWEEN 1 AND 256),
  extra_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_json))
) STRICT;

CREATE TABLE IF NOT EXISTS account_auth (
  uin INTEGER PRIMARY KEY REFERENCES account(uin) ON DELETE CASCADE,
  password_md5 BLOB NOT NULL CHECK (length(password_md5) = 16)
) STRICT;

CREATE TABLE IF NOT EXISTS title_catalog (
  title_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  star_level INTEGER NOT NULL DEFAULT 0 CHECK (star_level >= 0),
  description TEXT NOT NULL DEFAULT '',
  extra_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_json))
) STRICT;

CREATE TABLE IF NOT EXISTS item_catalog (
  item_id INTEGER PRIMARY KEY,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  charm INTEGER NOT NULL DEFAULT 0,
  intelligence INTEGER NOT NULL DEFAULT 0,
  strength INTEGER NOT NULL DEFAULT 0,
  hunger INTEGER NOT NULL DEFAULT 0,
  cleanliness INTEGER NOT NULL DEFAULT 0,
  min_level INTEGER,
  max_level INTEGER,
  image_path TEXT,
  extra_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_json)),
  CHECK (min_level IS NULL OR min_level >= 0),
  CHECK (max_level IS NULL OR max_level >= 0),
  CHECK (min_level IS NULL OR max_level IS NULL OR min_level <= max_level)
) STRICT;

CREATE TABLE IF NOT EXISTS wearable_catalog (
  item_id INTEGER PRIMARY KEY REFERENCES item_catalog(item_id) ON DELETE CASCADE,
  slot TEXT NOT NULL,
  suit_name TEXT,
  suit_contents TEXT,
  vip_required INTEGER NOT NULL DEFAULT 0 CHECK (vip_required IN (0, 1)),
  extra_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_json))
) STRICT;

CREATE TABLE IF NOT EXISTS travel_destination (
  destination_id INTEGER PRIMARY KEY,
  region TEXT NOT NULL,
  country TEXT NOT NULL,
  city TEXT NOT NULL,
  extra_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_json))
) STRICT;

CREATE TABLE IF NOT EXISTS robot_equipment_catalog (
  equipment_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slot TEXT NOT NULL,
  hp INTEGER NOT NULL DEFAULT 0,
  attack INTEGER NOT NULL DEFAULT 0,
  crit INTEGER NOT NULL DEFAULT 0,
  dodge INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  skill TEXT NOT NULL DEFAULT '',
  extra_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_json))
) STRICT;

CREATE TABLE IF NOT EXISTS titan_catalog (
  titan_item_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  item_type TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  extra_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_json))
) STRICT;

CREATE TABLE IF NOT EXISTS pet (
  pet_id TEXT PRIMARY KEY CHECK (
    length(pet_id) BETWEEN 1 AND 20 AND pet_id NOT GLOB '*[^0-9]*'
  ),
  uin INTEGER NOT NULL REFERENCES account(uin) ON DELETE CASCADE,
  pet_name TEXT NOT NULL,
  master_name TEXT NOT NULL,
  birthday TEXT,
  level INTEGER NOT NULL DEFAULT 0 CHECK (level >= 0),
  age_hours INTEGER NOT NULL DEFAULT 0 CHECK (age_hours >= 0),
  growth INTEGER NOT NULL DEFAULT 0 CHECK (growth >= 0),
  generation TEXT,
  sex TEXT,
  vip_level INTEGER NOT NULL DEFAULT 0 CHECK (vip_level >= 0),
  vip_year_flag INTEGER NOT NULL DEFAULT 0 CHECK (vip_year_flag IN (0, 1)),
  current_title TEXT,
  extra_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_json))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_pet_uin ON pet(uin);

CREATE TABLE IF NOT EXISTS pet_attribute (
  pet_id TEXT NOT NULL REFERENCES pet(pet_id) ON DELETE CASCADE,
  attribute_code TEXT NOT NULL,
  value INTEGER NOT NULL,
  rank_text TEXT,
  extra_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_json)),
  PRIMARY KEY (pet_id, attribute_code)
) STRICT;

CREATE TABLE IF NOT EXISTS pet_inventory (
  pet_id TEXT NOT NULL REFERENCES pet(pet_id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES item_catalog(item_id),
  quantity_text TEXT NOT NULL CHECK (length(quantity_text) > 0),
  acquired_at TEXT,
  extra_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_json)),
  PRIMARY KEY (pet_id, item_id)
) STRICT;

CREATE TABLE IF NOT EXISTS pet_title (
  pet_id TEXT NOT NULL REFERENCES pet(pet_id) ON DELETE CASCADE,
  title_id INTEGER NOT NULL REFERENCES title_catalog(title_id),
  acquired_at TEXT,
  extra_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_json)),
  PRIMARY KEY (pet_id, title_id)
) STRICT;

CREATE TABLE IF NOT EXISTS pet_travel (
  pet_id TEXT NOT NULL REFERENCES pet(pet_id) ON DELETE CASCADE,
  destination_id INTEGER NOT NULL REFERENCES travel_destination(destination_id),
  illuminated INTEGER NOT NULL DEFAULT 0 CHECK (illuminated IN (0, 1)),
  extra_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_json)),
  PRIMARY KEY (pet_id, destination_id)
) STRICT;

CREATE TABLE IF NOT EXISTS robot_state (
  pet_id TEXT PRIMARY KEY REFERENCES pet(pet_id) ON DELETE CASCADE,
  level INTEGER NOT NULL DEFAULT 0 CHECK (level >= 0),
  exp INTEGER NOT NULL DEFAULT 0 CHECK (exp >= 0),
  base_hp INTEGER NOT NULL DEFAULT 0,
  base_attack INTEGER NOT NULL DEFAULT 0,
  base_crit INTEGER NOT NULL DEFAULT 0,
  base_dodge INTEGER NOT NULL DEFAULT 0,
  equipped_head INTEGER REFERENCES robot_equipment_catalog(equipment_id),
  equipped_body INTEGER REFERENCES robot_equipment_catalog(equipment_id),
  equipped_hand INTEGER REFERENCES robot_equipment_catalog(equipment_id),
  extra_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_json))
) STRICT;

CREATE TABLE IF NOT EXISTS pet_robot_equipment (
  pet_id TEXT NOT NULL REFERENCES pet(pet_id) ON DELETE CASCADE,
  equipment_id INTEGER NOT NULL REFERENCES robot_equipment_catalog(equipment_id),
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  equipped INTEGER NOT NULL DEFAULT 0 CHECK (equipped IN (0, 1)),
  extra_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_json)),
  PRIMARY KEY (pet_id, equipment_id)
) STRICT;

CREATE TABLE IF NOT EXISTS titan_state (
  pet_id TEXT PRIMARY KEY REFERENCES pet(pet_id) ON DELETE CASCADE,
  level INTEGER NOT NULL DEFAULT 0 CHECK (level >= 0),
  exp INTEGER NOT NULL DEFAULT 0 CHECK (exp >= 0),
  current_armor INTEGER REFERENCES titan_catalog(titan_item_id),
  current_weapon INTEGER REFERENCES titan_catalog(titan_item_id),
  oil INTEGER NOT NULL DEFAULT 0,
  ore INTEGER NOT NULL DEFAULT 0,
  league_id INTEGER,
  extra_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_json))
) STRICT;

CREATE TABLE IF NOT EXISTS pet_titan_inventory (
  pet_id TEXT NOT NULL REFERENCES pet(pet_id) ON DELETE CASCADE,
  titan_item_id INTEGER NOT NULL REFERENCES titan_catalog(titan_item_id),
  level INTEGER NOT NULL DEFAULT 0 CHECK (level >= 0),
  quality TEXT,
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  extra_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_json)),
  PRIMARY KEY (pet_id, titan_item_id)
) STRICT;

-- Server-owned projection for the exact OF-2 Login/Hello wire contract.
-- This is not claimed to be a Tencent historical database table.
CREATE TABLE IF NOT EXISTS qqpenguin_login_profile (
  pet_id TEXT PRIMARY KEY REFERENCES pet(pet_id) ON DELETE CASCADE,
  pet_id_bytes BLOB NOT NULL UNIQUE CHECK (length(pet_id_bytes) = 8),
  pet_name_bytes BLOB NOT NULL CHECK (length(pet_name_bytes) = 16),
  master_name_bytes BLOB NOT NULL CHECK (length(master_name_bytes) = 16),
  auto_feed_flag INTEGER NOT NULL CHECK (auto_feed_flag BETWEEN 0 AND 65535),
  vip_flag INTEGER NOT NULL CHECK (vip_flag BETWEEN 0 AND 255),
  status_id INTEGER NOT NULL CHECK (status_id BETWEEN 0 AND 65535),
  status_description_bytes BLOB NOT NULL CHECK (length(status_description_bytes) = 16),
  status_time INTEGER NOT NULL CHECK (status_time BETWEEN 0 AND 4294967295),
  level_value INTEGER NOT NULL CHECK (level_value BETWEEN 0 AND 65535),
  unknown_0x3f INTEGER NOT NULL CHECK (unknown_0x3f BETWEEN 0 AND 4294967295),
  unknown_0x43 INTEGER NOT NULL CHECK (unknown_0x43 BETWEEN 0 AND 4294967295),
  unknown_0x47 INTEGER NOT NULL CHECK (unknown_0x47 BETWEEN 0 AND 65535),
  unknown_0x49 INTEGER NOT NULL CHECK (unknown_0x49 BETWEEN 0 AND 65535),
  unknown_0x4b INTEGER NOT NULL CHECK (unknown_0x4b BETWEEN 0 AND 65535),
  unknown_0x4d INTEGER NOT NULL CHECK (unknown_0x4d BETWEEN 0 AND 255),
  unknown_0x4e INTEGER NOT NULL CHECK (unknown_0x4e BETWEEN 0 AND 65535),
  bubble_id INTEGER NOT NULL CHECK (bubble_id BETWEEN 0 AND 4294967295),
  vehicle_id INTEGER NOT NULL CHECK (vehicle_id BETWEEN 0 AND 4294967295),
  decoration_stamp INTEGER NOT NULL CHECK (decoration_stamp BETWEEN 0 AND 65535),
  config_version INTEGER NOT NULL CHECK (config_version BETWEEN 0 AND 4294967295),
  avatar_version INTEGER NOT NULL CHECK (avatar_version BETWEEN 0 AND 65535),
  use_phase_flag INTEGER NOT NULL CHECK (use_phase_flag BETWEEN 0 AND 255),
  unknown_0x61 INTEGER NOT NULL CHECK (unknown_0x61 BETWEEN 0 AND 4294967295),
  unknown_0x65 INTEGER NOT NULL CHECK (unknown_0x65 BETWEEN 0 AND 255),
  unknown_0x66 INTEGER NOT NULL CHECK (unknown_0x66 BETWEEN 0 AND 255),
  unknown_0x67 INTEGER NOT NULL CHECK (unknown_0x67 BETWEEN 0 AND 4294967295),
  unknown_0x6b INTEGER NOT NULL CHECK (unknown_0x6b BETWEEN 0 AND 255),
  hello_interval INTEGER NOT NULL CHECK (hello_interval BETWEEN 0 AND 255),
  hello_unknown_0x1b INTEGER NOT NULL CHECK (hello_unknown_0x1b BETWEEN 0 AND 4294967295),
  extra_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_json))
) STRICT;

PRAGMA user_version = 1;
