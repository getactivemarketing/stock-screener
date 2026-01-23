import { json } from '@sveltejs/kit';
import { query } from '$lib/db';

export interface AlertRule {
  id: number;
  name: string;
  description: string | null;
  enabled: boolean;
  alert_type: string;
  conditions: object;
  channels: string[];
  created_at: string;
  updated_at: string;
}

export interface AlertHistory {
  id: number;
  ticker: string;
  alert_type: string;
  alert_timestamp: string;
  scores: object;
  classification: object;
  message: string;
  sent_to: string[];
}

// GET: Fetch alert rules and history
export async function GET({ url }) {
  const type = url.searchParams.get('type') || 'rules';

  try {
    if (type === 'rules') {
      const rules = await query<AlertRule>(`
        SELECT * FROM alert_rules ORDER BY created_at DESC
      `);
      return json({ rules });
    }

    if (type === 'history') {
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const history = await query<AlertHistory>(`
        SELECT * FROM alerts
        ORDER BY alert_timestamp DESC
        LIMIT $1
      `, [limit]);
      return json({ history });
    }

    if (type === 'stats') {
      const stats = await query<{
        alert_type: string;
        count: number;
        last_triggered: string;
      }>(`
        SELECT
          alert_type,
          COUNT(*) as count,
          MAX(alert_timestamp) as last_triggered
        FROM alerts
        WHERE alert_timestamp > NOW() - INTERVAL '30 days'
        GROUP BY alert_type
        ORDER BY count DESC
      `);
      return json({ stats });
    }

    return json({ error: 'Invalid type parameter' }, { status: 400 });
  } catch (error) {
    console.error('Failed to fetch alerts:', error);
    return json({ error: 'Failed to fetch alerts' }, { status: 500 });
  }
}

// POST: Create a new alert rule
export async function POST({ request }) {
  try {
    const body = await request.json();
    const { name, description, alertType, conditions, channels } = body;

    if (!name || !alertType || !conditions || !channels) {
      return json({ error: 'Missing required fields' }, { status: 400 });
    }

    const result = await query<AlertRule>(`
      INSERT INTO alert_rules (name, description, alert_type, conditions, channels)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [name, description || null, alertType, JSON.stringify(conditions), channels]);

    return json({ rule: result[0] }, { status: 201 });
  } catch (error) {
    console.error('Failed to create alert rule:', error);
    return json({ error: 'Failed to create alert rule' }, { status: 500 });
  }
}

// PUT: Update an alert rule
export async function PUT({ request }) {
  try {
    const body = await request.json();
    const { id, name, description, enabled, alertType, conditions, channels } = body;

    if (!id) {
      return json({ error: 'Missing rule ID' }, { status: 400 });
    }

    const setClauses: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (name !== undefined) {
      setClauses.push(`name = $${paramIndex++}`);
      values.push(name);
    }
    if (description !== undefined) {
      setClauses.push(`description = $${paramIndex++}`);
      values.push(description);
    }
    if (enabled !== undefined) {
      setClauses.push(`enabled = $${paramIndex++}`);
      values.push(enabled);
    }
    if (alertType !== undefined) {
      setClauses.push(`alert_type = $${paramIndex++}`);
      values.push(alertType);
    }
    if (conditions !== undefined) {
      setClauses.push(`conditions = $${paramIndex++}`);
      values.push(JSON.stringify(conditions));
    }
    if (channels !== undefined) {
      setClauses.push(`channels = $${paramIndex++}`);
      values.push(channels);
    }

    if (setClauses.length === 0) {
      return json({ error: 'No fields to update' }, { status: 400 });
    }

    setClauses.push(`updated_at = NOW()`);
    values.push(id);

    const result = await query<AlertRule>(`
      UPDATE alert_rules
      SET ${setClauses.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `, values);

    if (result.length === 0) {
      return json({ error: 'Rule not found' }, { status: 404 });
    }

    return json({ rule: result[0] });
  } catch (error) {
    console.error('Failed to update alert rule:', error);
    return json({ error: 'Failed to update alert rule' }, { status: 500 });
  }
}

// DELETE: Delete an alert rule
export async function DELETE({ url }) {
  const id = url.searchParams.get('id');

  if (!id) {
    return json({ error: 'Missing rule ID' }, { status: 400 });
  }

  try {
    await query('DELETE FROM alert_rules WHERE id = $1', [parseInt(id)]);
    return json({ success: true });
  } catch (error) {
    console.error('Failed to delete alert rule:', error);
    return json({ error: 'Failed to delete alert rule' }, { status: 500 });
  }
}
