/**
 * Handlers of `FoodStockService` (see `food-stock-service.cds`).
 *
 * Tobin's Week Ahead lives here: `weekAhead()` forecasts every ingredient that has a row in
 * `SupplyRules` (nothing is hard-coded per ingredient), `saveSupplyRule` / `removeSupplyRule`
 * let the app follow or unfollow an ingredient, and a small watch writes a `Notifications` row
 * when the status of an ingredient changes. The calculations are in `lib/stock-forecast.ts`.
 *
 * `@sap/cds` ships no TypeScript declarations in this project, so it is loaded with `require`
 * and the part of its API this file uses is described in the small interfaces below.
 */
import { forecastItem, sortWorstFirst, type IncomingOrder, type WeekAheadItem } from './lib/stock-forecast';
import { detectChanges, startStockWatch, type StatusChange, type WatchedRule } from './lib/stock-watch';

const SUPPLY_RULES = 'oakhaven.curse.SupplyRules';
const STOCK_ITEMS = 'oakhaven.curse.StockItems';
const NOTIFICATIONS = 'oakhaven.curse.Notifications';
const STOCK_ORDERS = 'oakhaven.curse.StockOrders';
const STOCK_RECEIVALS = 'oakhaven.curse.StockReceivals';

interface SaveSupplyRuleData {
  item_ID?: string;
  supplier?: string;
  leadTimeDays?: number;
  saturdayFactor?: number;
}

/** The slice of a CAP request this file uses. */
interface CdsRequest<T> {
  readonly data: T;
  error(code: number, message: string, target?: string): void;
}

/** The slice of a CAP service this file uses. */
interface CdsService {
  init(): Promise<void>;
  on(event: string, handler: (req: CdsRequest<never>) => unknown): void;
}

interface OrderRow {
  ID: string;
  item_ID: string;
  quantity: number | string | null;
  expectedAt: string | null;
  status: string | null;
}

interface RuleRow {
  ID: string;
  item_ID: string;
  supplier: string | null;
  leadTimeDays: number | null;
  saturdayFactor: number | string | null;
  lastStatus: string | null;
}

interface ItemRow {
  ID: string;
  itemID: string;
  name: string | null;
  icon: string | null;
  unit: string | null;
  currentQuantity: number | string | null;
  minStockLevel: number | string | null;
  consumptionRate: number | string | null;
}

/** The slice of the `cds` facade this file uses. */
interface CdsApi {
  readonly ApplicationService: new (...args: readonly never[]) => CdsService;
  readonly ql: {
    readonly SELECT: {
      from(entity: string): {
        columns(...columns: readonly string[]): {
          where(predicate: Readonly<Record<string, unknown>>): PromiseLike<unknown[]>;
        } & PromiseLike<unknown[]>;
      };
    };
    readonly INSERT: { into(entity: string): { entries(rows: readonly object[]): PromiseLike<unknown> } };
    readonly UPDATE: {
      (entity: string): { set(values: object): { where(predicate: Readonly<Record<string, unknown>>): PromiseLike<unknown> } };
    };
    readonly DELETE: { from(entity: string): { where(predicate: Readonly<Record<string, unknown>>): PromiseLike<unknown> } };
  };
  log(module: string): { info(...args: readonly unknown[]): void };
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cds = require('@sap/cds') as CdsApi;
const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;
const log = cds.log('food-stock');

/** Everything the forecast needs: the followed items, their rules and their forecast. */
async function loadWeekAhead(): Promise<{ items: Array<WeekAheadItem & { itemUUID: string }>; rules: Map<string, WatchedRule> }> {
  const rules = (await SELECT.from(SUPPLY_RULES).columns(
    'ID', 'item_ID', 'supplier', 'leadTimeDays', 'saturdayFactor', 'lastStatus',
  )) as RuleRow[];
  const watched = new Map<string, WatchedRule>();
  if (rules.length === 0) return { items: [], rules: watched };

  const stock = (await SELECT.from(STOCK_ITEMS)
    .columns('ID', 'itemID', 'name', 'icon', 'unit', 'currentQuantity', 'minStockLevel', 'consumptionRate')
    .where({ ID: { in: rules.map((rule) => rule.item_ID) } })) as ItemRow[];
  const stockByUUID = new Map(stock.map((row) => [row.ID, row]));

  const openOrders = (await SELECT.from(STOCK_ORDERS)
    .columns('ID', 'item_ID', 'quantity', 'expectedAt', 'status')
    .where({ status: 'open', item_ID: { in: rules.map((rule) => rule.item_ID) } })) as OrderRow[];
  const incomingByItem = new Map<string, IncomingOrder[]>();
  for (const order of openOrders) {
    if (!order.expectedAt) continue;
    const list = incomingByItem.get(order.item_ID) ?? [];
    list.push({ expectedAt: order.expectedAt, quantity: Number(order.quantity ?? 0) });
    incomingByItem.set(order.item_ID, list);
  }

  const today = new Date();
  const items: Array<WeekAheadItem & { itemUUID: string }> = [];
  for (const rule of rules) {
    const row = stockByUUID.get(rule.item_ID);
    if (!row) continue;
    items.push({
      itemUUID: row.ID,
      ...forecastItem(
        {
          itemID: row.itemID,
          name: row.name ?? row.itemID,
          icon: row.icon ?? '',
          unit: row.unit ?? '',
          currentQuantity: Number(row.currentQuantity ?? 0),
          minStockLevel: Number(row.minStockLevel ?? 0),
          consumptionRate: Number(row.consumptionRate ?? 0),
        },
        {
          supplier: rule.supplier ?? '',
          leadTimeDays: rule.leadTimeDays ?? 0,
          saturdayFactor: Number(rule.saturdayFactor ?? 1),
        },
        today,
        incomingByItem.get(rule.item_ID) ?? [],
      ),
    });
    watched.set(row.itemID, { ruleID: rule.ID, itemUUID: row.ID, lastStatus: rule.lastStatus });
  }
  return { items: sortWorstFirst(items), rules: watched };
}

/** Writes a notification for every status change and remembers the new status. */
async function syncStatusNotifications(): Promise<void> {
  const { items, rules } = await loadWeekAhead();
  const { notify, record } = detectChanges(items, rules);

  if (notify.length > 0) {
    await INSERT.into(NOTIFICATIONS).entries(
      notify.map((change) => ({ item_ID: change.itemUUID, message: change.message, acknowledged: false })),
    );
    log.info(`${notify.length} stock status notification(s) written`);
  }

  const byStatus = new Map<string, string[]>();
  for (const change of [...notify, ...record] as StatusChange[]) {
    byStatus.set(change.status, [...(byStatus.get(change.status) ?? []), change.ruleID]);
  }
  for (const [status, ids] of byStatus) {
    await UPDATE(SUPPLY_RULES).set({ lastStatus: status }).where({ ID: { in: ids } });
  }
}

/** Adds what arrived to the stock and records the delivery. A negative (unreliable) stock counts as 0. */
async function bookDelivery(itemUUID: string, quantity: number): Promise<void> {
  const [item] = (await SELECT.from(STOCK_ITEMS).columns('ID', 'currentQuantity').where({ ID: itemUUID })) as Array<{
    ID: string;
    currentQuantity: number | string | null;
  }>;
  const rules = (await SELECT.from(SUPPLY_RULES).columns('supplier').where({ item_ID: itemUUID })) as Array<{
    supplier: string | null;
  }>;
  const newQuantity = Math.max(Number(item.currentQuantity ?? 0), 0) + quantity;
  await INSERT.into(STOCK_RECEIVALS).entries([
    {
      item_ID: itemUUID,
      quantityReceived: quantity,
      supplier: rules[0]?.supplier ?? '',
      receivedAt: new Date().toISOString(),
    },
  ]);
  await UPDATE(STOCK_ITEMS).set({ currentQuantity: newQuantity }).where({ ID: itemUUID });
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export default class FoodStockService extends cds.ApplicationService {
  override async init(): Promise<void> {
    this.on('weekAhead', async () => (await loadWeekAhead()).items);

    this.on('saveSupplyRule', async (req) => {
      const { item_ID, supplier, leadTimeDays, saturdayFactor } = req.data as SaveSupplyRuleData;
      if (!item_ID) return req.error(400, 'Kies een ingrediënt.', 'item_ID');
      if (leadTimeDays === undefined || leadTimeDays === null || leadTimeDays < 0) {
        return req.error(400, 'De levertijd moet 0 dagen of meer zijn.', 'leadTimeDays');
      }
      if (saturdayFactor !== undefined && saturdayFactor !== null && saturdayFactor <= 0) {
        return req.error(400, 'De zaterdagfactor moet groter zijn dan 0.', 'saturdayFactor');
      }
      const items = await SELECT.from(STOCK_ITEMS).columns('ID').where({ ID: item_ID });
      if (items.length === 0) return req.error(404, 'Dit ingrediënt bestaat niet.', 'item_ID');

      const values = { supplier: supplier ?? '', leadTimeDays, saturdayFactor: saturdayFactor ?? 1 };
      const existing = await SELECT.from(SUPPLY_RULES).columns('ID').where({ item_ID });
      if (existing.length > 0) await UPDATE(SUPPLY_RULES).set(values).where({ item_ID });
      else await INSERT.into(SUPPLY_RULES).entries([{ item_ID, ...values }]);
      return true;
    });

    this.on('removeSupplyRule', async (req) => {
      const { item_ID } = req.data as { item_ID?: string };
      if (!item_ID) return req.error(400, 'Kies een ingrediënt.', 'item_ID');
      await DELETE.from(SUPPLY_RULES).where({ item_ID });
      return true;
    });

    // After an order or delivery the status can change: write the notification right away
    // instead of waiting for the next check of the watch.
    const refreshNotifications = async (): Promise<void> => {
      try {
        await syncStatusNotifications();
      } catch (error) {
        log.info('could not refresh the stock notifications', error);
      }
    };

    this.on('placeOrder', async (req) => {
      const { item_ID, quantity, expectedAt } = req.data as {
        item_ID?: string;
        quantity?: number;
        expectedAt?: string;
      };
      if (!item_ID) return req.error(400, 'Kies een ingrediënt.', 'item_ID');
      if (!quantity || quantity <= 0) return req.error(400, 'De hoeveelheid moet groter zijn dan 0.', 'quantity');
      if (!expectedAt || !ISO_DATE.test(expectedAt)) {
        return req.error(400, 'Kies de dag waarop de levering verwacht wordt.', 'expectedAt');
      }
      const items = await SELECT.from(STOCK_ITEMS).columns('ID').where({ ID: item_ID });
      if (items.length === 0) return req.error(404, 'Dit ingrediënt bestaat niet.', 'item_ID');
      await INSERT.into(STOCK_ORDERS).entries([{ item_ID, quantity, expectedAt, status: 'open' }]);
      await refreshNotifications();
      return true;
    });

    this.on('receiveOrder', async (req) => {
      const { order_ID, quantityReceived } = req.data as { order_ID?: string; quantityReceived?: number };
      if (!order_ID) return req.error(400, 'Kies een bestelling.', 'order_ID');
      if (!quantityReceived || quantityReceived <= 0) {
        return req.error(400, 'De ontvangen hoeveelheid moet groter zijn dan 0.', 'quantityReceived');
      }
      const [order] = (await SELECT.from(STOCK_ORDERS)
        .columns('ID', 'item_ID', 'status')
        .where({ ID: order_ID })) as OrderRow[];
      if (!order) return req.error(404, 'Deze bestelling bestaat niet.', 'order_ID');
      if (order.status !== 'open') return req.error(409, 'Deze bestelling is al afgehandeld.', 'order_ID');
      await bookDelivery(order.item_ID, quantityReceived);
      await UPDATE(STOCK_ORDERS).set({ status: 'received', receivedQuantity: quantityReceived }).where({ ID: order_ID });
      await refreshNotifications();
      return true;
    });

    this.on('receiveDelivery', async (req) => {
      const { item_ID, quantityReceived } = req.data as { item_ID?: string; quantityReceived?: number };
      if (!item_ID) return req.error(400, 'Kies een ingrediënt.', 'item_ID');
      if (!quantityReceived || quantityReceived <= 0) {
        return req.error(400, 'De ontvangen hoeveelheid moet groter zijn dan 0.', 'quantityReceived');
      }
      const items = await SELECT.from(STOCK_ITEMS).columns('ID').where({ ID: item_ID });
      if (items.length === 0) return req.error(404, 'Dit ingrediënt bestaat niet.', 'item_ID');
      await bookDelivery(item_ID, quantityReceived);
      await refreshNotifications();
      return true;
    });

    this.on('cancelOrder', async (req) => {
      const { order_ID } = req.data as { order_ID?: string };
      if (!order_ID) return req.error(400, 'Kies een bestelling.', 'order_ID');
      const [order] = (await SELECT.from(STOCK_ORDERS).columns('ID', 'status').where({ ID: order_ID })) as OrderRow[];
      if (!order) return req.error(404, 'Deze bestelling bestaat niet.', 'order_ID');
      if (order.status !== 'open') return req.error(409, 'Deze bestelling is al afgehandeld.', 'order_ID');
      await UPDATE(STOCK_ORDERS).set({ status: 'cancelled' }).where({ ID: order_ID });
      await refreshNotifications();
      return true;
    });

    startStockWatch(syncStatusNotifications);
    return super.init();
  }
}
