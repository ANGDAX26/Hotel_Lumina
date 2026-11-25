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
    const r = await pool.query(`SELECT t.*, COALESCE((SELECT ROUND(AVG(calificacion),1)::float FROM resenas WHERE id_tipo = t.id_tipo),0) AS rating, (SELECT COUNT(*)::int FROM resenas WHERE id_tipo = t.id_tipo) AS n_resenas FROM tipos_habitacion t ORDER BY t.precio_noche`);
    res.json(r.rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'No se pudieron cargar las habitaciones' }); }
});

app.get('/api/servicios', async (_req, res) => {
  try {
    const r = await pool.query('SELECT id_servicio, nombre_servicio, categoria, precio, imagen_url FROM servicios ORDER BY categoria, nombre_servicio');
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
  const { nombre, doc, tel, correo, rfc, tipo, num, ci, co, pago } = req.body || {};
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

    let pagado = false;
    if (pago && pago.metodo === 'tarjeta') {
      const c = cobrar(pago);
      if (!c.ok) throw { status: 402, msg: c.msg };
      await client.query('INSERT INTO pagos (id_reservacion, monto, metodo_pago, folio_factura) VALUES ($1,$2,$3,$4)',
        [rs.rows[0].id_reservacion, total, 'Tarjeta ****' + c.last4, 'P-' + Date.now()]);
      pagado = true;
    }
    await client.query('COMMIT');
    res.json({ ok: true, folio: rs.rows[0].id_reservacion, habitacion: hab.rows[0].numero_habitacion, tipo: t.rows[0].nombre_tipo, noches, total, pagado });
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
           COUNT(h.id_habitacion)::int AS disponibles, t.imagenes, (SELECT COALESCE(ROUND(AVG(calificacion),1),0)::float FROM resenas WHERE id_tipo = t.id_tipo) AS rating
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
  if (estado === 'Cancelada') { await cancelar(req.params.id); return res.json({ ok: true }); }
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


// ---------- Pasarela de pago SIMULADA (demo): nunca se guarda el número de tarjeta ----------
function cobrar(p) {
  const n = String(p.numero || '').replace(/\s+/g, '');
  if (!/^\d{13,19}$/.test(n)) return { ok: false, msg: 'Número de tarjeta inválido' };
  let sum = 0, alt = false;
  for (let i = n.length - 1; i >= 0; i--) { let d = +n[i]; if (alt) { d *= 2; if (d > 9) d -= 9; } sum += d; alt = !alt; }
  if (sum % 10) return { ok: false, msg: 'Número de tarjeta inválido' };
  const m = /^(\d{2})\/(\d{2})$/.exec(p.exp || '');
  if (!m || +m[1] < 1 || +m[1] > 12 || new Date(2000 + +m[2], +m[1]) < new Date()) return { ok: false, msg: 'Tarjeta vencida o fecha inválida' };
  if (!/^\d{3,4}$/.test(p.cvv || '')) return { ok: false, msg: 'CVV inválido' };
  if (n.endsWith('0002')) return { ok: false, msg: 'Pago rechazado por el banco (tarjeta de prueba)' };
  return { ok: true, last4: n.slice(-4) };
}

async function cancelar(id) {
  const r = await pool.query("UPDATE reservaciones SET estado = 'Cancelada' WHERE id_reservacion = $1 RETURNING id_habitacion", [id]);
  if (!r.rows[0]) return 0;
  await pool.query("UPDATE habitaciones SET estado = 'Disponible' WHERE id_habitacion = $1 AND estado = 'Ocupada'", [r.rows[0].id_habitacion]);
  const p = await pool.query('SELECT COALESCE(SUM(monto),0)::float AS s FROM pagos WHERE id_reservacion = $1', [id]);
  const s = p.rows[0].s;
  if (s > 0) await pool.query("INSERT INTO pagos (id_reservacion, monto, metodo_pago, folio_factura) VALUES ($1,$2,'Reembolso',$3)", [id, -s, 'R-' + Date.now()]);
  return s;
}

// ---------- Detalle de habitación y reseñas ----------
app.get('/api/tipos/:id', wrap(async (req, res) => {
  const t = await pool.query(`SELECT t.*, COALESCE((SELECT ROUND(AVG(calificacion),1)::float FROM resenas WHERE id_tipo = t.id_tipo),0) AS rating,
    (SELECT COUNT(*)::int FROM resenas WHERE id_tipo = t.id_tipo) AS n_resenas FROM tipos_habitacion t WHERE t.id_tipo = $1`, [+req.params.id || 0]);
  if (!t.rows[0]) return res.status(404).json({ error: 'No encontrada' });
  const r = await pool.query('SELECT nombre, calificacion, comentario, fecha FROM resenas WHERE id_tipo = $1 ORDER BY fecha DESC LIMIT 20', [t.rows[0].id_tipo]);
  res.json({ tipo: t.rows[0], resenas: r.rows });
}));

// ---------- Panel del huésped: consultar, pagar, cancelar, opinar ----------
const SEL_RES = `SELECT r.id_reservacion AS folio, r.estado, r.fecha_checkin, r.fecha_checkout, r.num_huespedes, r.total_hospedaje::float AS total,
  hu.nombre_completo, hab.numero_habitacion, t.id_tipo, t.nombre_tipo, t.imagenes,
  COALESCE((SELECT SUM(subtotal) FROM cargos_habitacion c WHERE c.id_reservacion = r.id_reservacion),0)::float AS cargos,
  COALESCE((SELECT SUM(monto) FROM pagos p WHERE p.id_reservacion = r.id_reservacion),0)::float AS pagado,
  EXISTS (SELECT 1 FROM resenas z WHERE z.id_reservacion = r.id_reservacion) AS resenada
  FROM reservaciones r JOIN huespedes hu ON hu.id_huesped = r.id_huesped
  JOIN habitaciones hab ON hab.id_habitacion = r.id_habitacion JOIN tipos_habitacion t ON t.id_tipo = hab.id_tipo
  WHERE r.id_reservacion = $1 AND hu.documento_identidad = $2`;
const buscarReserva = async b => (await pool.query(SEL_RES, [+(b || {}).folio || 0, String((b || {}).doc || '').trim()])).rows[0];
const NF = { error: 'No encontramos esa reservación. Revisa el folio y tu INE o pasaporte.' };

app.post('/api/mi-reserva', wrap(async (req, res) => {
  const r = await buscarReserva(req.body); r ? res.json(r) : res.status(404).json(NF);
}));
app.post('/api/mi-reserva/cancelar', wrap(async (req, res) => {
  const r = await buscarReserva(req.body); if (!r) return res.status(404).json(NF);
  if (r.estado !== 'Confirmada') return res.status(400).json({ error: 'Solo se pueden cancelar reservaciones confirmadas' });
  res.json({ ok: true, reembolso: await cancelar(r.folio) });
}));
app.post('/api/mi-reserva/pagar', wrap(async (req, res) => {
  const r = await buscarReserva(req.body); if (!r) return res.status(404).json(NF);
  if (r.estado === 'Cancelada') return res.status(400).json({ error: 'La reservación está cancelada' });
  const saldo = Math.round((r.total + r.cargos - r.pagado) * 100) / 100;
  if (saldo <= 0) return res.status(400).json({ error: 'No hay saldo pendiente' });
  const c = cobrar((req.body || {}).pago || {});
  if (!c.ok) return res.status(402).json({ error: c.msg });
  await pool.query('INSERT INTO pagos (id_reservacion, monto, metodo_pago, folio_factura) VALUES ($1,$2,$3,$4)', [r.folio, saldo, 'Tarjeta ****' + c.last4, 'P-' + Date.now()]);
  res.json({ ok: true, monto: saldo });
}));
app.post('/api/resenas', wrap(async (req, res) => {
  const r = await buscarReserva(req.body); if (!r) return res.status(404).json(NF);
  if (r.estado !== 'Finalizada') return res.status(400).json({ error: 'Podrás opinar cuando termine tu estancia' });
  if (r.resenada) return res.status(400).json({ error: 'Ya enviaste tu reseña' });
  const c = +req.body.calificacion;
  if (!(c >= 1 && c <= 5)) return res.status(400).json({ error: 'Calificación inválida' });
  await pool.query('INSERT INTO resenas (id_tipo, id_reservacion, nombre, calificacion, comentario) VALUES ($1,$2,$3,$4,$5)',
    [r.id_tipo, r.folio, r.nombre_completo.split(' ')[0], c, String(req.body.comentario || '').slice(0, 500)]);
  res.json({ ok: true });
}));

// ---------- Admin: editar catálogo y ver pagos ----------
app.post('/api/admin/tipos/:id', auth, wrap(async (req, res) => {
  const b = req.body;
  await pool.query('UPDATE tipos_habitacion SET nombre_tipo=$1, descripcion=$2, capacidad_personas=$3, precio_noche=$4, amenidades=$5, imagenes=$6 WHERE id_tipo=$7',
    [b.nombre_tipo, b.descripcion, +b.capacidad_personas, +b.precio_noche, b.amenidades, b.imagenes, req.params.id]);
  res.json({ ok: true });
}));
app.post('/api/admin/servicios/:id', auth, wrap(async (req, res) => {
  const b = req.body;
  await pool.query('UPDATE servicios SET nombre_servicio=$1, categoria=$2, precio=$3, imagen_url=$4 WHERE id_servicio=$5',
    [b.nombre_servicio, b.categoria, +b.precio, b.imagen_url, req.params.id]);
  res.json({ ok: true });
}));
app.get('/api/admin/pagos', auth, wrap(async (_req, res) => {
  const r = await pool.query(`SELECT p.id_pago, p.id_reservacion, p.fecha_pago, p.monto::float AS monto, p.metodo_pago, p.folio_factura, hu.nombre_completo
    FROM pagos p JOIN reservaciones r ON r.id_reservacion = p.id_reservacion JOIN huespedes hu ON hu.id_huesped = r.id_huesped
    ORDER BY p.fecha_pago DESC LIMIT 100`);
  res.json(r.rows);
}));


// ---------- Restaurante: mesas y reservas de mesa ----------
app.get('/api/mesas/disponibles', wrap(async (req, res) => {
  const { fecha, hora, personas } = req.query;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '') || !/^\d{2}:\d{2}$/.test(hora || '')) return res.status(400).json({ error: 'Elige fecha y hora' });
  const r = await pool.query(`SELECT m.id_mesa, m.numero, m.zona, m.capacidad FROM mesas m
    WHERE m.activa AND m.capacidad >= $3 AND NOT EXISTS (SELECT 1 FROM reservas_mesa r
      WHERE r.id_mesa = m.id_mesa AND r.fecha = $1::date AND r.hora = $2::time AND r.estado = 'Confirmada')
    ORDER BY m.capacidad, m.numero`, [fecha, hora, +personas || 1]);
  res.json(r.rows);
}));
app.post('/api/mesas/reservar', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.nombre || !b.id_mesa || !b.fecha || !b.hora) return res.status(400).json({ error: 'Faltan datos' });
  if (b.fecha < new Date().toISOString().slice(0, 10)) return res.status(400).json({ error: 'La fecha ya pasó' });
  const m = await pool.query('SELECT numero, capacidad FROM mesas WHERE id_mesa = $1 AND activa', [b.id_mesa]);
  if (!m.rows[0] || m.rows[0].capacidad < (+b.personas || 1)) return res.status(400).json({ error: 'Mesa no disponible para esa cantidad de personas' });
  try {
    const r = await pool.query('INSERT INTO reservas_mesa (id_mesa, nombre, telefono, fecha, hora, personas) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id_reserva_mesa',
      [b.id_mesa, b.nombre, b.telefono || null, b.fecha, b.hora, +b.personas || 1]);
    res.json({ ok: true, folio: r.rows[0].id_reserva_mesa, mesa: m.rows[0].numero });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Esa mesa se acaba de reservar. Elige otra.' });
    throw e;
  }
}));
app.get('/api/admin/mesas', auth, wrap(async (_req, res) => {
  res.json((await pool.query('SELECT * FROM mesas ORDER BY numero')).rows);
}));
app.post('/api/admin/mesas', auth, wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.numero || !(+b.capacidad > 0)) return res.status(400).json({ error: 'Número y capacidad son obligatorios' });
  try {
    await pool.query('INSERT INTO mesas (numero, zona, capacidad) VALUES ($1,$2,$3)', [b.numero, b.zona || 'Salón', +b.capacidad]);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Ya existe una mesa con ese número' });
    throw e;
  }
}));
app.post('/api/admin/mesas/:id', auth, wrap(async (req, res) => {
  const b = req.body || {};
  try {
    await pool.query('UPDATE mesas SET numero=$1, zona=$2, capacidad=$3, activa=$4 WHERE id_mesa=$5', [b.numero, b.zona, +b.capacidad, !!b.activa, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Ya existe una mesa con ese número' });
    throw e;
  }
}));
app.get('/api/admin/reservas-mesa', auth, wrap(async (_req, res) => {
  res.json((await pool.query(`SELECT r.id_reserva_mesa, m.numero, r.nombre, r.telefono, to_char(r.fecha,'YYYY-MM-DD') AS fecha,
    to_char(r.hora,'HH24:MI') AS hora, r.personas, r.estado FROM reservas_mesa r JOIN mesas m ON m.id_mesa = r.id_mesa
    ORDER BY r.fecha DESC, r.hora DESC LIMIT 200`)).rows);
}));
app.post('/api/admin/reservas-mesa/:id/estado', auth, wrap(async (req, res) => {
  if (!['Completada', 'Cancelada'].includes(req.body.estado)) return res.status(400).json({ error: 'Estado inválido' });
  await pool.query('UPDATE reservas_mesa SET estado = $1 WHERE id_reserva_mesa = $2', [req.body.estado, req.params.id]);
  res.json({ ok: true });
}));

app.listen(process.env.PORT || 3000, () => console.log('Hotel Lumina en línea'));
