import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { query } from '$lib/db';

export const GET: RequestHandler = async ({ url }) => {
  const action = url.searchParams.get('action') || null;
  const tier = url.searchParams.get('tier') || null;
  const classification = url.searchParams.get('classification') || null;
  const limit = parseInt(url.searchParams.get('limit') || '50');
  const offset = parseInt(url.searchParams.get('offset') || '0');

  try {
    let whereClause = 'WHERE 1=1';
    const params: unknown[] = [];
    let paramIndex = 1;

    if (action) {
      whereClause += ` AND t.action = $${paramIndex++}`;
      params.push(action.toUpperCase());
    }

    if (tier) {
      whereClause += ` AND sr.tier = $${paramIndex++}`;
      params.push(tier.toUpperCase());
    }

    if (classification) {
      whereClause += ` AND t.classification = $${paramIndex++}`;
      params.push(classification);
    }

    const countParams = [...params];
    params.push(limit, offset);

    const trades = await query(
      `SELECT t.*,
        sr.company_name,
        sr.tier,
        sr.value_score,
        sr.catalyst_score,
        sr.emerging_industry_score,
        sr.price as current_price
      FROM trades t
      LEFT JOIN scan_results sr ON sr.id = t.scan_result_id
      ${whereClause}
      ORDER BY t.created_at DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      params
    );

    const countResult = await query(
      `SELECT COUNT(*) as total FROM trades t
       LEFT JOIN scan_results sr ON sr.id = t.scan_result_id
       ${whereClause}`,
      countParams
    );

    return json({
      trades,
      total: parseInt((countResult[0] as any)?.total || '0'),
      limit,
      offset,
    });
  } catch (error) {
    console.error('Trades API error:', error);
    return json({ error: 'Failed to fetch trades' }, { status: 500 });
  }
};
