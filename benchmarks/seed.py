"""Generate the 10,000 seed rows once (data/seed.json, fixed RNG) and (re)load them into an app's SQLite file.
usage: python seed.py gen | python seed.py load <db-file> [--create]"""
import json, random, sqlite3, sys, os
HERE = os.path.dirname(os.path.abspath(__file__))
SEED = os.path.join(HERE, 'data', 'seed.json')
DDL = ('CREATE TABLE IF NOT EXISTS "items" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL, '
       '"price" REAL NOT NULL, "category" TEXT NOT NULL, "created_at" INTEGER NOT NULL)')

def gen():
    r = random.Random(42)
    cats = ['hats', 'scarves', 'gloves', 'shoes', 'bags', 'belts', 'socks', 'coats']
    base = 1767225600000  # 2026-01-01T00:00:00Z, epoch ms (Tvine's datetime storage on SQLite)
    rows = [[i, f'item-{i}-{r.randrange(16**6):06x}', round(r.uniform(1, 500), 2), r.choice(cats), base + i * 60_000 + r.randrange(1000)]
            for i in range(1, 10001)]
    json.dump(rows, open(SEED, 'w'))

def load(db, create):
    rows = json.load(open(SEED))
    c = sqlite3.connect(db)
    c.execute('PRAGMA journal_mode=WAL')
    if create: c.execute(DDL)
    c.execute('DELETE FROM items')
    c.execute("DELETE FROM sqlite_sequence WHERE name='items'") if c.execute("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").fetchone() else None
    c.executemany('INSERT INTO items (id, name, price, category, created_at) VALUES (?,?,?,?,?)', rows)
    c.commit()
    c.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    print(db, c.execute('SELECT count(*), max(id) FROM items').fetchone(), c.execute('PRAGMA journal_mode').fetchone())

if __name__ == '__main__':
    gen() if sys.argv[1] == 'gen' else load(sys.argv[2], '--create' in sys.argv)
