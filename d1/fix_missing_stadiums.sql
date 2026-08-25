-- One-time fix: 5 international-game stadium_ids from the 2026 schedule that
-- were never loaded into the `stadium` dimension table, causing
-- "FOREIGN KEY constraint failed" on the weekly-refresh.yml `game` upsert
-- (2026-08-25 run). See HANDOFF.md for the full writeup.
--
-- Safe to run more than once -- INSERT OR IGNORE.
INSERT OR IGNORE INTO stadium (stadium_id, stadium_name) VALUES ('MEL00', 'Melbourne Cricket Ground');
INSERT OR IGNORE INTO stadium (stadium_id, stadium_name) VALUES ('RIO00', 'Maracana Stadium');
INSERT OR IGNORE INTO stadium (stadium_id, stadium_name) VALUES ('PAR00', 'Stade de France');
INSERT OR IGNORE INTO stadium (stadium_id, stadium_name) VALUES ('MAD01', 'Bernabeu');
INSERT OR IGNORE INTO stadium (stadium_id, stadium_name) VALUES ('MUN01', 'FC Bayern Munich Stadium');
