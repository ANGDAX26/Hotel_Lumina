const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.get('/api/tipos', async (_req, res) => {
  try {
    const r = await pool.query('SELECT id_tipo, nombre_tipo, descripcion, capacidad_personas, precio_noche FROM tipos_habitacion ORDER BY precio_noche');
    res.json(r.rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'No se pudieron cargar las habitaciones' }); }
});

app.get('/api/servicios', async (_req, res) => {
  try {
    const r = await pool.query('SELECT id_servicio, nombre_servicio, categoria, precio FROM servicios ORDER BY categoria, nombre_servicio');
    res.json(r.rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'No se pudieron cargar los servicios' }); }
});

// Busca una habitación libre del tipo pedido en el rango de fechas
const SQL_LIBRE = `
  SELECT h.id_habitacion, h.numero_habitacion
  FROM habitaciones h
  WHERE h.id_tipo = $1
    AND h.estado <> 'Mantenimiento'
    AND NOT EXISTS (
      SELECT 1 FROM reservaciones r
      WHERE r.id_habitacion = h.id_habitacion
        AND r.estado IN ('Confirmada','En curso')
        AND r.fecha_checkin < $3::timestamp
        AND r.fecha_checkout > $2::timestamp)
  ORDER BY h.numero_habitacion
  LIMIT 1`;

app.post('/api/reservar', async (req, res) => {
  const { nombre, doc, tel, correo, rfc, tipo, num, ci, co } = req.body || {};
  if (!nombre || !doc || !tipo || !ci || !co) return res.status(400).json({ error: 'Faltan datos obligatorios' });
  const inicio = `${ci} 15:00`, fin = `${co} 12:00`;
  const noches = Math.round((new Date(co) - new Date(ci)) / 864e5);
  if (!(noches >= 1)) return res.status(400).json({ error: 'La salida debe ser posterior a la entrada' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const t = await client.query('SELECT nombre_tipo, capacidad_personas, precio_noche FROM tipos_habitacion WHERE id_tipo = $1', [tipo]);
    if (!t.rows[0]) throw { status: 400, msg: 'Tipo de habitación inválido' };
    if ((+num || 1) > t.rows[0].capacidad_personas) throw { status: 400, msg: `Máximo ${t.rows[0].capacidad_personas} huésped(es) en esta habitación` };

    const hab = await client.query(SQL_LIBRE, [tipo, inicio, fin]);
    if (!hab.rows[0]) throw { status: 409, msg: 'No hay habitaciones disponibles de ese tipo en esas fechas' };

    const hu = await client.query(
      `INSERT INTO huespedes (nombre_completo, documento_identidad, telefono, correo, rfc)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (documento_identidad) DO UPDATE
         SET nombre_completo = EXCLUDED.nombre_completo,
             telefono = COALESCE(NULLIF(EXCLUDED.telefono,''), huespedes.telefono),
             correo = COALESCE(NULLIF(EXCLUDED.correo,''), huespedes.correo)
       RETURNING id_huesped`,
      [nombre, doc, tel || null, correo || null, rfc || null]);

    const total = noches * Number(t.rows[0].precio_noche);
    const rs = await client.query(
      `INSERT INTO reservaciones (id_huesped, id_habitacion, fecha_checkin, fecha_checkout, num_huespedes, total_hospedaje)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id_reservacion`,
      [hu.rows[0].id_huesped, hab.rows[0].id_habitacion, inicio, fin, +num || 1, total]);

    await client.query('COMMIT');
    res.json({ ok: true, folio: rs.rows[0].id_reservacion, habitacion: hab.rows[0].numero_habitacion, tipo: t.rows[0].nombre_tipo, noches, total });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.status) return res.status(e.status).json({ error: e.msg });
    console.error(e); res.status(500).json({ error: 'Error al guardar la reservación' });
  } finally { client.release(); }
});

app.listen(process.env.PORT || 3000, () => console.log('Hotel Lumina en línea'));
