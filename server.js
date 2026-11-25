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


const crypto = require('crypto');
const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (e) { console.error(e); res.status(500).json({ error: 'Error del servidor' }); } };

// ---------- Disponibilidad pública (estilo Booking) ----------
app.get('/api/disponibilidad', wrap(async (req, res) => {
  const { ci, co, num } = req.query;
  const noches = Math.round((new Date(co) - new Date(ci)) / 864e5);
  if (!(noches >= 1)) return res.status(400).json({ error: 'Elige fechas válidas (salida posterior a entrada)' });
  const r = await pool.query(`
    SELECT t.id_tipo, t.nombre_tipo, t.descripcion, t.capacidad_personas, t.precio_noche,
           COUNT(h.id_habitacion)::int AS disponibles
    FROM tipos_habitacion t
    LEFT JOIN habitaciones h ON h.id_tipo = t.id_tipo AND h.estado <> 'Mantenimiento'
      AND NOT EXISTS (SELECT 1 FROM reservaciones r WHERE r.id_habitacion = h.id_habitacion
        AND r.estado IN ('Confirmada','En curso')
        AND r.fecha_checkin < $2::timestamp AND r.fecha_checkout > $1::timestamp)
    WHERE t.capacidad_personas >= $3
    GROUP BY t.id_tipo ORDER BY t.precio_noche`, [`${ci} 15:00`, `${co} 12:00`, +num || 1]);
  res.json({ noches, tipos: r.rows });
}));

// ---------- Panel de administración ----------
const tokens = new Set();
app.post('/api/admin/login', (req, res) => {
  if (!process.env.ADMIN_PASSWORD) return res.status(500).json({ error: 'Falta la variable ADMIN_PASSWORD en Render' });
  if ((req.body || {}).password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Contraseña incorrecta' });
  const t = crypto.randomBytes(24).toString('hex'); tokens.add(t); res.json({ token: t });
});
const auth = (req, res, next) => tokens.has(req.headers['x-token']) ? next() : res.status(401).json({ error: 'Sesión expirada' });

app.get('/api/admin/resumen', auth, wrap(async (_req, res) => {
  const hab = await pool.query('SELECT estado, COUNT(*)::int AS n FROM habitaciones GROUP BY estado');
  const k = await pool.query(`SELECT
    (SELECT COUNT(*)::int FROM reservaciones WHERE estado = 'Confirmada') AS confirmadas,
    (SELECT COUNT(*)::int FROM reservaciones WHERE estado = 'En curso') AS en_curso,
    (SELECT COALESCE(SUM(monto),0) FROM pagos) AS ingresos`);
  res.json({ hab: hab.rows, ...k.rows[0] });
}));

app.get('/api/admin/reservaciones', auth, wrap(async (_req, res) => {
  const r = await pool.query(`
    SELECT r.id_reservacion, r.estado, r.fecha_checkin, r.fecha_checkout, r.num_huespedes, r.total_hospedaje,
           hu.nombre_completo, hu.telefono, hab.numero_habitacion, t.nombre_tipo,
           COALESCE((SELECT SUM(subtotal) FROM cargos_habitacion c WHERE c.id_reservacion = r.id_reservacion),0) AS cargos,
           COALESCE((SELECT SUM(monto) FROM pagos p WHERE p.id_reservacion = r.id_reservacion),0) AS pagado
    FROM reservaciones r
    JOIN huespedes hu ON hu.id_huesped = r.id_huesped
    JOIN habitaciones hab ON hab.id_habitacion = r.id_habitacion
    JOIN tipos_habitacion t ON t.id_tipo = hab.id_tipo
    ORDER BY r.fecha_checkin DESC LIMIT 200`);
  res.json(r.rows);
}));

app.post('/api/admin/reservaciones/:id/estado', auth, wrap(async (req, res) => {
  const map = { 'Confirmada': null, 'En curso': 'Ocupada', 'Finalizada': 'Limpieza', 'Cancelada': 'Disponible' };
  const { estado } = req.body;
  if (!(estado in map)) return res.status(400).json({ error: 'Estado inválido' });
  const r = await pool.query('UPDATE reservaciones SET estado = $1 WHERE id_reservacion = $2 RETURNING id_habitacion', [estado, req.params.id]);
  if (map[estado] && r.rows[0]) await pool.query('UPDATE habitaciones SET estado = $1 WHERE id_habitacion = $2', [map[estado], r.rows[0].id_habitacion]);
  res.json({ ok: true });
}));

app.post('/api/admin/reservaciones/:id/cargo', auth, wrap(async (req, res) => {
  const { id_servicio, cantidad } = req.body;
  await pool.query(`INSERT INTO cargos_habitacion (id_reservacion, id_servicio, cantidad, subtotal)
    SELECT $1, id_servicio, $3, precio * $3 FROM servicios WHERE id_servicio = $2`, [req.params.id, id_servicio, +cantidad || 1]);
  res.json({ ok: true });
}));

app.post('/api/admin/reservaciones/:id/pago', auth, wrap(async (req, res) => {
  const { monto, metodo } = req.body;
  if (!(+monto > 0)) return res.status(400).json({ error: 'Monto inválido' });
  await pool.query('INSERT INTO pagos (id_reservacion, monto, metodo_pago, folio_factura) VALUES ($1,$2,$3,$4)',
    [req.params.id, +monto, metodo || 'Efectivo', 'F-' + Date.now()]);
  res.json({ ok: true });
}));

app.get('/api/admin/habitaciones', auth, wrap(async (_req, res) => {
  const r = await pool.query(`SELECT h.id_habitacion, h.numero_habitacion, h.piso, h.estado, t.nombre_tipo
    FROM habitaciones h JOIN tipos_habitacion t ON t.id_tipo = h.id_tipo ORDER BY h.numero_habitacion`);
  res.json(r.rows);
}));

app.post('/api/admin/habitaciones/:id/estado', auth, wrap(async (req, res) => {
  if (!['Disponible','Ocupada','Limpieza','Mantenimiento'].includes(req.body.estado)) return res.status(400).json({ error: 'Estado inválido' });
  await pool.query('UPDATE habitaciones SET estado = $1 WHERE id_habitacion = $2', [req.body.estado, req.params.id]);
  res.json({ ok: true });
}));

app.listen(process.env.PORT || 3000, () => console.log('Hotel Lumina en línea'));
