-- Ejecutar UNA VEZ en el SQL Editor de Neon (base Lumina_Hotel) ANTES de desplegar
ALTER TABLE tipos_habitacion ADD COLUMN IF NOT EXISTS imagenes TEXT, ADD COLUMN IF NOT EXISTS amenidades TEXT;
ALTER TABLE servicios ADD COLUMN IF NOT EXISTS imagen_url TEXT;

CREATE TABLE IF NOT EXISTS resenas (
  id_resena SERIAL PRIMARY KEY,
  id_tipo INT REFERENCES tipos_habitacion(id_tipo),
  id_reservacion INT UNIQUE REFERENCES reservaciones(id_reservacion),
  nombre VARCHAR(100) NOT NULL,
  calificacion INT NOT NULL CHECK (calificacion BETWEEN 1 AND 5),
  comentario TEXT,
  fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP);

UPDATE tipos_habitacion SET imagenes='/img/sencilla.jpg', amenidades='Wi-Fi gratis,Aire acondicionado,TV por cable,Baño privado,Escritorio' WHERE nombre_tipo='Sencilla' AND imagenes IS NULL;
UPDATE tipos_habitacion SET imagenes='/img/doble.jpg', amenidades='Wi-Fi gratis,Aire acondicionado,TV por cable,Dos camas matrimoniales,Minibar' WHERE nombre_tipo='Doble' AND imagenes IS NULL;
UPDATE tipos_habitacion SET imagenes='/img/junior-suite.jpg', amenidades='Wi-Fi gratis,Aire acondicionado,Cama king,Sala integrada,Minibar,Vista panorámica' WHERE nombre_tipo='Junior Suite' AND imagenes IS NULL;
UPDATE tipos_habitacion SET imagenes='/img/master-suite.jpg', amenidades='Wi-Fi gratis,Aire acondicionado,Cama king,Sala y comedor,Terraza privada,Jacuzzi,Minibar' WHERE nombre_tipo='Master Suite' AND imagenes IS NULL;

UPDATE servicios SET imagen_url='/img/desayuno.jpg' WHERE nombre_servicio='Desayuno Buffet' AND imagen_url IS NULL;
UPDATE servicios SET imagen_url='/img/room-service.jpg' WHERE nombre_servicio='Room Service' AND imagen_url IS NULL;
UPDATE servicios SET imagen_url='/img/spa.jpg' WHERE nombre_servicio='Spa' AND imagen_url IS NULL;
UPDATE servicios SET imagen_url='/img/lavanderia.jpg' WHERE nombre_servicio='Lavandería' AND imagen_url IS NULL;

INSERT INTO resenas (id_tipo, nombre, calificacion, comentario)
SELECT (SELECT id_tipo FROM tipos_habitacion WHERE nombre_tipo = t), n, c, m
FROM (VALUES
 ('Sencilla','Carlos',4,'Limpia y cómoda, perfecta para un viaje de trabajo.'),
 ('Doble','Mariana',5,'Muy amplia y la cama es buenísima. Volveremos.'),
 ('Doble','Luis',4,'Excelente ubicación y buen servicio en recepción.'),
 ('Junior Suite','Andrea',5,'La vista es espectacular, el desayuno estuvo delicioso.'),
 ('Master Suite','Roberto',5,'La terraza privada es lo mejor. Vale cada peso.')) v(t,n,c,m)
WHERE NOT EXISTS (SELECT 1 FROM resenas);
