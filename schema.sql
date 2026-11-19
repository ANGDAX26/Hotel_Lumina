-- Ejecutar en el SQL Editor de Neon (base Lumina_Hotel)
CREATE TABLE IF NOT EXISTS roles (
  id_rol SERIAL PRIMARY KEY, nombre_rol VARCHAR(50) NOT NULL, descripcion TEXT);
CREATE TABLE IF NOT EXISTS personal (
  id_personal SERIAL PRIMARY KEY, nombre VARCHAR(100) NOT NULL, apellidos VARCHAR(100) NOT NULL,
  id_rol INT REFERENCES roles(id_rol), turno VARCHAR(30), fecha_contratacion DATE);
CREATE TABLE IF NOT EXISTS huespedes (
  id_huesped SERIAL PRIMARY KEY, nombre_completo VARCHAR(150) NOT NULL,
  documento_identidad VARCHAR(30) UNIQUE NOT NULL, telefono VARCHAR(20), correo VARCHAR(100), rfc VARCHAR(13));
CREATE TABLE IF NOT EXISTS tipos_habitacion (
  id_tipo SERIAL PRIMARY KEY, nombre_tipo VARCHAR(50) NOT NULL, descripcion TEXT,
  capacidad_personas INT NOT NULL, precio_noche DECIMAL(10,2) NOT NULL);
CREATE TABLE IF NOT EXISTS habitaciones (
  id_habitacion SERIAL PRIMARY KEY, numero_habitacion VARCHAR(10) UNIQUE NOT NULL, piso INT NOT NULL,
  id_tipo INT REFERENCES tipos_habitacion(id_tipo), estado VARCHAR(30) DEFAULT 'Disponible');
CREATE TABLE IF NOT EXISTS reservaciones (
  id_reservacion SERIAL PRIMARY KEY, id_huesped INT REFERENCES huespedes(id_huesped),
  id_habitacion INT REFERENCES habitaciones(id_habitacion), id_personal INT REFERENCES personal(id_personal),
  fecha_checkin TIMESTAMP NOT NULL, fecha_checkout TIMESTAMP NOT NULL, num_huespedes INT DEFAULT 1,
  estado VARCHAR(30) DEFAULT 'Confirmada', total_hospedaje DECIMAL(10,2) NOT NULL);
CREATE TABLE IF NOT EXISTS servicios (
  id_servicio SERIAL PRIMARY KEY, nombre_servicio VARCHAR(100) NOT NULL, categoria VARCHAR(50), precio DECIMAL(10,2) NOT NULL);
CREATE TABLE IF NOT EXISTS cargos_habitacion (
  id_cargo SERIAL PRIMARY KEY, id_reservacion INT REFERENCES reservaciones(id_reservacion),
  id_servicio INT REFERENCES servicios(id_servicio), cantidad INT NOT NULL DEFAULT 1,
  subtotal DECIMAL(10,2) NOT NULL, fecha_cargo TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS pagos (
  id_pago SERIAL PRIMARY KEY, id_reservacion INT REFERENCES reservaciones(id_reservacion),
  fecha_pago TIMESTAMP DEFAULT CURRENT_TIMESTAMP, monto DECIMAL(10,2) NOT NULL,
  metodo_pago VARCHAR(50), folio_factura VARCHAR(50) UNIQUE);

-- Datos iniciales (solo si las tablas están vacías)
INSERT INTO tipos_habitacion (nombre_tipo, descripcion, capacidad_personas, precio_noche)
SELECT * FROM (VALUES
 ('Sencilla','Cama individual, escritorio y baño privado.',1,1200.00),
 ('Doble','Dos camas matrimoniales, ideal para parejas o amigos.',2,1800.00),
 ('Junior Suite','Sala integrada, cama king y vista panorámica.',3,2600.00),
 ('Master Suite','Sala, comedor y terraza privada.',4,4200.00)) v
WHERE NOT EXISTS (SELECT 1 FROM tipos_habitacion);

INSERT INTO habitaciones (numero_habitacion, piso, id_tipo)
SELECT n, p, (SELECT id_tipo FROM tipos_habitacion WHERE nombre_tipo = t)
FROM (VALUES
 ('101',1,'Sencilla'),('102',1,'Sencilla'),('103',1,'Doble'),('104',1,'Doble'),
 ('201',2,'Doble'),('202',2,'Doble'),('203',2,'Junior Suite'),('204',2,'Junior Suite'),
 ('301',3,'Junior Suite'),('302',3,'Master Suite')) v(n,p,t)
WHERE NOT EXISTS (SELECT 1 FROM habitaciones);

INSERT INTO servicios (nombre_servicio, categoria, precio)
SELECT * FROM (VALUES
 ('Desayuno Buffet','Alimentos',250.00),('Room Service','Alimentos',320.00),
 ('Spa','Bienestar',900.00),('Lavandería','Servicios',180.00)) v
WHERE NOT EXISTS (SELECT 1 FROM servicios);
