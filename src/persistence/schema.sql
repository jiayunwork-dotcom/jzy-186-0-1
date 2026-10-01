-- GHG 核算后端 PostgreSQL 16 schema
-- 所有不可变事实表只增不改；更正以新行表达。
-- 数值统一使用 NUMERIC(38,12) 字符串传输，应用层用 Decimal(40 位) 运算。

CREATE TABLE IF NOT EXISTS factor_versions (
    id              TEXT PRIMARY KEY,
    label           TEXT NOT NULL,
    effective_start TEXT NOT NULL CHECK (effective_start ~ '^\d{4}-(0[1-9]|1[0-2])$'),
    effective_end   TEXT CHECK (effective_end IS NULL OR effective_end ~ '^\d{4}-(0[1-9]|1[0-2])$'),
    published_at    TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS factor_rows (
    id                TEXT PRIMARY KEY,
    factor_version_id TEXT NOT NULL REFERENCES factor_versions(id),
    fuel_or_activity  TEXT NOT NULL,
    type              TEXT NOT NULL CHECK (type IN ('emission','density','ncv_mass','ncv_volume')),
    gas               TEXT CHECK (gas IS NULL OR gas IN ('CO2','CH4','N2O')),
    scope             SMALLINT CHECK (scope IS NULL OR scope IN (1,2)),
    value             NUMERIC(38,12) NOT NULL CHECK (value >= 0),
    unit              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_factor_rows_version ON factor_rows(factor_version_id);

CREATE TABLE IF NOT EXISTS gwp_sets (
    id           TEXT PRIMARY KEY,
    label        TEXT NOT NULL,
    published_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS gwp_values (
    gwp_set_id TEXT NOT NULL REFERENCES gwp_sets(id),
    gas        TEXT NOT NULL CHECK (gas IN ('CO2','CH4','N2O')),
    value      NUMERIC(38,12) NOT NULL CHECK (value > 0),
    PRIMARY KEY (gwp_set_id, gas)
);

CREATE TABLE IF NOT EXISTS activity_records (
    id              TEXT PRIMARY KEY,
    supersedes_id   TEXT REFERENCES activity_records(id),
    root_id         TEXT NOT NULL,
    plant_id        TEXT NOT NULL,
    source_id       TEXT NOT NULL,
    fuel_or_activity TEXT NOT NULL,
    month           TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
    quantity        NUMERIC(38,12) NOT NULL CHECK (quantity >= 0),
    unit            TEXT NOT NULL,
    seq             BIGINT NOT NULL UNIQUE,
    accepted_at     TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_root ON activity_records(root_id);
CREATE INDEX IF NOT EXISTS idx_activity_seq ON activity_records(seq);
CREATE INDEX IF NOT EXISTS idx_activity_dim ON activity_records(plant_id, month);

-- 并发更正冲突的保证：
-- 应用层在 SERIALIZABLE 事务内先对 root_id 取 pg_advisory_xact_lock，
-- 再校验“目标仍是链头”并插入；两条并发更正锁同一把键，
-- 后到者在临界区内观察到前者已插入的子记录而返回 409。
-- 同编号记录重复提交由主键拒绝，天然幂等。

CREATE TABLE IF NOT EXISTS closure_snapshots (
    id                TEXT PRIMARY KEY,
    plant_id          TEXT,
    month             TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
    activity_seq      BIGINT NOT NULL,
    factor_version_id TEXT NOT NULL REFERENCES factor_versions(id),
    gwp_set_id        TEXT NOT NULL REFERENCES gwp_sets(id),
    result_hash       TEXT NOT NULL,
    result            JSONB NOT NULL,
    closed_at         TIMESTAMPTZ NOT NULL,
    UNIQUE (plant_id, month)
);

CREATE TABLE IF NOT EXISTS base_year_flags (
    id                    TEXT PRIMARY KEY,
    base_year             TEXT NOT NULL UNIQUE,
    triggered_at          TIMESTAMPTZ NOT NULL,
    factor_version_id     TEXT NOT NULL,
    gwp_set_id            TEXT NOT NULL,
    activity_seq          BIGINT NOT NULL,
    reference_closure_id  TEXT REFERENCES closure_snapshots(id),
    baseline_total        NUMERIC(38,12) NOT NULL,
    restated_total        NUMERIC(38,12) NOT NULL,
    change_ratio          NUMERIC(38,12) NOT NULL,
    threshold             NUMERIC(12,6) NOT NULL,
    note                  TEXT NOT NULL
);
