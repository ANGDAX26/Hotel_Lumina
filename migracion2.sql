-- Ejecutar UNA VEZ en el SQL Editor de Neon (base Lumina_Hotel) ANTES de desplegar
CREATE TABLE IF NOT EXISTS mesas (
  id_mesa SERIAL PRIMARY KEY,
  numero VARCHAR(10) UNIQUE NOT NULL,
  zona VARCHAR(40) DEFAULT 'Salón',
  capacidad INT NOT NULL CHECK (capacidad > 0),
  activa BOOLEAN DEFAULT TRUE);

CREATE TABLE IF NOT EXISTS reservas_mesa (
  id_reserva_mesa SERIAL PRIMARY KEY,
  id_mesa INT NOT NULL REFERENCES mesas(id_mesa),
  nombre VARCHAR(100) NOT NULL,
  telefono VARCHAR(20),
  fecha DATE NOT NULL,
  hora TIME NOT NULL,
  personas INT NOT NULL DEFAULT 2,
  estado VARCHAR(20) DEFAULT 'Confirmada',
  creada TIMESTAMP DEFAULT CURRENT_TIMESTAMP);

-- Evita dos reservas confirmadas de la misma mesa a la misma hora
CREATE UNIQUE INDEX IF NOT EXISTS ux_mesa_slot ON reservas_mesa (id_mesa, fecha, hora) WHERE estado = 'Confirmada';

INSERT INTO mesas (numero, zona, capacidad)
SELECT * FROM (VALUES ('M1','Terraza',2),('M2','Terraza',2),('M3','Salón',4),('M4','Salón',4),('M5','Salón',6),('M6','Jardín',8)) v
WHERE NOT EXISTS (SELECT 1 FROM mesas);
