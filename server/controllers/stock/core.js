/**
 * @module stock/core
 *
 * @description
 * This module is responsible for handling all function utility for stock
 *
 * @requires moment
 * @requires lib/db
 * @requires lib/filter
 * @requires config/identifiers
 */

const _ = require('lodash');
const moment = require('moment');
const db = require('../../lib/db');
const FilterParser = require('../../lib/filter');
const identifiers = require('../../config/identifiers');
const util = require('../../lib/util');

const flux = {
  FROM_PURCHASE    : 1,
  FROM_OTHER_DEPOT : 2,
  FROM_ADJUSTMENT  : 3,
  FROM_PATIENT     : 4,
  FROM_SERVICE     : 5,
  FROM_DONATION    : 6,
  FROM_LOSS        : 7,
  TO_OTHER_DEPOT   : 8,
  TO_PATIENT       : 9,
  TO_SERVICE       : 10,
  TO_LOSS          : 11,
  TO_ADJUSTMENT    : 12,
  FROM_INTEGRATION : 13,
};

const DATE_FORMAT = 'YYYY-MM-DD';
const BASE_NUMBER_OF_MONTHS = 6;

// exports
exports.flux = flux;
exports.getLots = getLots;
exports.getLotsDepot = getLotsDepot;
exports.getLotsMovements = getLotsMovements;
exports.getLotsOrigins = getLotsOrigins;
exports.stockManagementProcess = stockManagementProcess;

// stock consumption
exports.getStockConsumption = getStockConsumption;
exports.getStockConsumptionAverage = getStockConsumptionAverage;
exports.getInventoryQuantityAndConsumption = getInventoryQuantityAndConsumption;
exports.getInventoryMovements = getInventoryMovements;

/**
 * @function getLotFilters
 *
 * @description
 * Groups all filtering functionality used in the different getLots* functions into
 * a single function.  The filterparser is returned so that any additional modifications
 * can be made in the function before execution.
 *
 * @param {Object} parameters - an object of filter params.
 */

function getLotFilters(parameters) {
  // clone the parameters
  const params = { ...parameters };

  db.convert(params, [
    'uuid',
    'depot_uuid',
    'lot_uuid',
    'inventory_uuid',
    'group_uuid',
    'document_uuid',
    'entity_uuid',
    'service_uuid',
    'invoice_uuid',
  ]);

  const filters = new FilterParser(params);

  filters.equals('uuid', 'uuid', 'l');
  filters.equals('is_assigned', 'is_assigned', 'l');
  filters.equals('depot_text', 'text', 'd');
  filters.equals('depot_uuid', 'depot_uuid', 'm');
  filters.equals('entity_uuid', 'entity_uuid', 'm');
  filters.equals('document_uuid', 'document_uuid', 'm');
  filters.equals('lot_uuid', 'lot_uuid', 'm');
  filters.equals('inventory_uuid', 'uuid', 'i');
  filters.equals('consumable', 'consumable', 'i');
  filters.equals('group_uuid', 'uuid', 'ig');
  filters.equals('text', 'text', 'i');
  filters.equals('label', 'label', 'l');
  filters.equals('is_exit', 'is_exit', 'm');
  filters.equals('flux_id', 'flux_id', 'm', true);
  filters.equals('reference', 'text', 'dm');
  filters.equals('service_uuid', 'uuid', 'serv');
  filters.equals('invoice_uuid', 'invoice_uuid', 'm');

  // NOTE(@jniles):
  // this filters the lots on the entity_uuid associated with the text reference.  It is
  // an "IN" filter because the patient could have a patient_uuid or debtor_uuid specified.
  filters.custom('patientReference',
    'entity_uuid IN (SELECT uuid FROM entity_map WHERE text = ?)');

  filters.period('defaultPeriod', 'date');
  filters.period('defaultPeriodEntry', 'entry_date', 'l');
  filters.period('period', 'date');

  filters.dateFrom('expiration_date_from', 'expiration_date', 'l');
  filters.dateTo('expiration_date_to', 'expiration_date', 'l');

  /**
   * the real entry date for a lot is the MIN(movement.date) for a
   * lot in a given depot so that we can identify for each depot
   * the entry date of a lot
   */
  filters.dateFrom('entry_date_from', 'date', 'm');
  filters.dateTo('entry_date_to', 'date', 'm');

  filters.dateFrom('dateFrom', 'date', 'm');
  filters.dateTo('dateTo', 'date', 'm');

  filters.dateFrom('custom_period_start', 'date', 'm');
  filters.dateTo('custom_period_end', 'date', 'm');

  filters.equals('user_id', 'user_id', 'm');

  return filters;
}

/**
 * @function getLots
 *
 * @description returns a list of lots
 *
 * @param {string} sql - An optional sql script of selecting in lot
 * @param {object} parameters - A request query object
 * @param {string} finalClauseParameter - An optional final clause (GROUP BY, HAVING, ...) to add to query built
 */
function getLots(sqlQuery, parameters, finalClauseParameter) {
  const finalClause = finalClauseParameter;
  const sql = sqlQuery || `
      SELECT
        BUID(l.uuid) AS uuid, l.label, l.initial_quantity, l.unit_cost, BUID(l.origin_uuid) AS origin_uuid,
        l.expiration_date, BUID(l.inventory_uuid) AS inventory_uuid, i.delay, l.entry_date,
        i.code, i.text, BUID(m.depot_uuid) AS depot_uuid, d.text AS depot_text, iu.text AS unit_type,
        BUID(ig.uuid) AS group_uuid, ig.name AS group_name,
        dm.text AS documentReference, ser.name AS service_name
      FROM lot l
      JOIN inventory i ON i.uuid = l.inventory_uuid
      JOIN inventory_unit iu ON iu.id = i.unit_id
      JOIN inventory_group ig ON ig.uuid = i.group_uuid
      JOIN stock_movement m ON m.lot_uuid = l.uuid AND m.flux_id = ${flux.FROM_PURCHASE}
      LEFT JOIN document_map dm ON dm.uuid = m.document_uuid
      LEFT JOIN service AS ser ON ser.uuid = m.entity_uuid
      JOIN depot d ON d.uuid = m.depot_uuid
  `;

  const filters = getLotFilters(parameters);

  // if finalClause is an empty string, filterParser will not group, it will be an empty string
  filters.setGroup(finalClause || '');

  const query = filters.applyQuery(sql);
  const queryParameters = filters.parameters();
  return db.exec(query, queryParameters);
}

/**
 * @function getLotsDepot
 *
 * @description returns lots with their real quantity in each depots
 *
 * @param {number} depot_uuid - optional depot uuid for retrieving on depot
 *
 * @param {object} params - A request query object
 *
 * @param {string} finalClause - An optional final clause (GROUP BY, ...) to add to query built
 */
function getLotsDepot(depotUuid, params, finalClause) {
  let _status;
  // token of query to add if only no empty lots should be returned
  let excludeToken = '';

  if (depotUuid) {
    params.depot_uuid = depotUuid;
  }

  if (params.status) {
    _status = params.status;
    delete params.status;
  }

  if (Number(params.includeEmptyLot) === 0) {
    excludeToken = 'HAVING quantity > 0';
    delete params.includeEmptyLot;
  }

  const sql = `
    SELECT BUID(l.uuid) AS uuid, l.label, l.initial_quantity,
      SUM(m.quantity * IF(m.is_exit = 1, -1, 1)) AS quantity,
      d.text AS depot_text, l.unit_cost, l.expiration_date,
      ROUND(DATEDIFF(l.expiration_date, CURRENT_DATE()) / 30.5) AS lifetime,
      BUID(l.inventory_uuid) AS inventory_uuid, BUID(l.origin_uuid) AS origin_uuid,
      i.code, i.text, BUID(m.depot_uuid) AS depot_uuid,
      m.date AS entry_date,
      i.avg_consumption, i.purchase_interval, i.delay,
      iu.text AS unit_type,
      ig.name AS group_name, ig.expires,
      dm.text AS documentReference
    FROM stock_movement m
    JOIN lot l ON l.uuid = m.lot_uuid
    JOIN inventory i ON i.uuid = l.inventory_uuid
    JOIN inventory_unit iu ON iu.id = i.unit_id
    JOIN inventory_group ig ON ig.uuid = i.group_uuid
    JOIN depot d ON d.uuid = m.depot_uuid
    LEFT JOIN document_map dm ON dm.uuid = m.document_uuid
  `;

  const groupByClause = finalClause || ` GROUP BY l.uuid, m.depot_uuid ${excludeToken} ORDER BY i.code, l.label `;

  const filters = getLotFilters(params);
  filters.setGroup(groupByClause);

  const query = filters.applyQuery(sql);
  const queryParameters = filters.parameters();
  return db.exec(query, queryParameters)
    .then(inventories => processStockConsumptionAverage(inventories, params.dateTo))
    .then(stockManagementProcess)
    .then(processMultipleLots)
    .then((rows) => {
      if (_status) {
        return rows.filter(row => row.status === _status);
      }
      return rows;
    });
}

/**
 * @function getLotsMovements
 *
 * @description returns lots movements for each depots
 *
 * @param {number} depot_uuid - optional depot uuid for retrieving on depot
 *
 * @param {object} params - A request query object
 */
function getLotsMovements(depotUuid, params) {
  let finalClause;

  if (depotUuid) {
    params.depot_uuid = depotUuid;
  }

  if (params.groupByDocument === 1) {
    finalClause = 'GROUP BY document_uuid';
    delete params.groupByDocument;
  }

  const sql = `
    SELECT
      BUID(l.uuid) AS uuid, l.label, l.initial_quantity, m.quantity, m.reference, m.description,
      d.text AS depot_text, IF(is_exit = 1, "OUT", "IN") AS io, l.unit_cost,
      l.expiration_date, BUID(l.inventory_uuid) AS inventory_uuid,
      BUID(l.origin_uuid) AS origin_uuid, l.entry_date, i.code, i.text,
      BUID(m.depot_uuid) AS depot_uuid, m.is_exit, m.date, BUID(m.document_uuid) AS document_uuid,
      m.flux_id, BUID(m.entity_uuid) AS entity_uuid, m.unit_cost,
      f.label AS flux_label, i.delay,
      iu.text AS unit_type,
      dm.text AS documentReference
    FROM stock_movement m
    JOIN lot l ON l.uuid = m.lot_uuid
    JOIN inventory i ON i.uuid = l.inventory_uuid
    JOIN inventory_unit iu ON iu.id = i.unit_id
    JOIN depot d ON d.uuid = m.depot_uuid
    JOIN flux f ON f.id = m.flux_id
    LEFT JOIN document_map dm ON dm.uuid = m.document_uuid
    LEFT JOIN service AS serv ON serv.uuid = m.entity_uuid
  `;

  return getLots(sql, params, finalClause);
}

/**
 * @function getLotsOrigins
 *
 * @description returns lot's origins
 *
 * @param {number} depot_uuid - optional depot uuid for retrieving on depot
 *
 * @param {object} params - A request query object
 */
function getLotsOrigins(depotUuid, params) {
  if (depotUuid) {
    params.depot_uuid = depotUuid;
  }

  const sql = `
    SELECT BUID(l.uuid) AS uuid, l.label, l.unit_cost, l.expiration_date,
        BUID(l.inventory_uuid) AS inventory_uuid, BUID(l.origin_uuid) AS origin_uuid,
        l.entry_date, i.code, i.text, origin.display_name, origin.reference,
        BUID(m.document_uuid) AS document_uuid, m.flux_id,
        iu.text AS unit_type,
        dm.text AS documentReference
    FROM lot l
    JOIN inventory i ON i.uuid = l.inventory_uuid
    JOIN inventory_unit iu ON iu.id = i.unit_id
    JOIN (
      SELECT
        p.uuid, CONCAT_WS('.', '${identifiers.PURCHASE_ORDER.key}', proj.abbr, p.reference) AS reference,
        'STOCK.PURCHASE_ORDER' AS display_name
      FROM
        purchase p JOIN project proj ON proj.id = p.project_id
      UNION
      SELECT
        d.uuid, CONCAT_WS('.', '${identifiers.DONATION.key}', proj.abbr, d.reference) AS reference,
        'STOCK.DONATION' AS display_name
        FROM
          donation d JOIN project proj ON proj.id = d.project_id
      UNION
      SELECT
        i.uuid, CONCAT_WS('.', '${identifiers.INTEGRATION.key}', proj.abbr, i.reference) AS reference,
        'STOCK.INTEGRATION' AS display_name
        FROM
          integration i JOIN project proj ON proj.id = i.project_id
    ) AS origin ON origin.uuid = l.origin_uuid
    JOIN stock_movement m ON m.lot_uuid = l.uuid AND m.is_exit = 0
      AND m.flux_id IN (${flux.FROM_PURCHASE}, ${flux.FROM_DONATION}, ${flux.FROM_INTEGRATION})
    LEFT JOIN document_map dm ON dm.uuid = m.document_uuid
  `;

  return getLots(sql, params);
}

/**
 * Stock Management Processing
 */
function stockManagementProcess(inventories) {
  const current = moment();
  let CM;
  let Q;
  let CM_NOT_ZERO;
  let delay;

  return inventories.map((inventory) => {
    Q = inventory.quantity; // the quantity
    CM = inventory.avg_consumption; // consommation mensuelle
    CM_NOT_ZERO = !CM ? 1 : CM;
    inventory.S_SEC = CM * inventory.delay; // stock de securite
    inventory.S_MIN = inventory.S_SEC * 2; // stock minimum
    inventory.S_MAX = (CM * inventory.purchase_interval) + inventory.S_MIN; // stock maximum
    inventory.S_MONTH = Math.floor(inventory.quantity / CM_NOT_ZERO); // mois de stock
    inventory.S_Q = inventory.S_MAX - inventory.quantity; // Commande d'approvisionnement
    inventory.S_Q = inventory.S_Q > 0 ? parseInt(inventory.S_Q, 10) : 0;
    inventory.S_RP = inventory.quantity - (inventory.lifetime * CM); // risque peremption

    if (Q <= 0) {
      inventory.status = 'sold_out';
    } else if (Q > 0 && Q <= inventory.S_SEC) {
      inventory.status = 'security_reached';
    } else if (Q > inventory.S_SEC && Q <= inventory.S_MIN) {
      inventory.status = 'minimum_reached';
    } else if (Q > inventory.S_MIN && Q <= inventory.S_MAX) {
      inventory.status = 'in_stock';
    } else if (Q > inventory.S_MAX) {
      inventory.status = 'over_maximum';
    } else {
      inventory.status = '';
    }

    // Round
    inventory.S_SEC = util.roundDecimal(inventory.S_SEC, 2);
    inventory.S_MIN = util.roundDecimal(inventory.S_MIN, 2);
    inventory.S_MAX = util.roundDecimal(inventory.S_MAX, 2);

    delay = moment(new Date(inventory.expiration_date)).diff(current);
    inventory.delay_expiration = moment.duration(delay).humanize();

    return inventory;
  });
}

/**
 * @function getStockConsumption
 *
 * @description returns the monthly (periodic) stock consumption (CM)
 *
 * @param {array} periodIds
 */
function getStockConsumption(periodIds) {
  const sql = `
    SELECT SUM(s.quantity) AS quantity, BUID(i.uuid) AS uuid, i.text, i.code, d.text
    FROM stock_consumption s
    JOIN inventory i ON i.uuid = s.inventory_uuid
    JOIN depot d ON d.uuid = s.depot_uuid
    JOIN period p ON p.id = s.period_id
    WHERE p.id IN (?)
    GROUP BY i.uuid, d.uuid
  `;
  return db.exec(sql, [periodIds]);
}

/**
 * @function getStockConsumptionAverage
 *
 * @description
 * Algorithm to calculate the CMM (consommation moyenne mensuelle) or average stock consumption
 * over a period for each stock item that has been consumed.
 * NOTA: A FISCAL YEAR MUST BE DEFINED FOR THE FEATURE WORK PROPERLY
 *
 * @param {number} periodId - the base period
 * @param {Date} periodDate - a date for finding the correspondant period
 * @param {number} numberOfMonths - the number of months for calculating the average (optional)
 */
async function getStockConsumptionAverage(periodId, periodDate, numberOfMonths = BASE_NUMBER_OF_MONTHS) {
  const baseDate = periodDate
    ? moment(periodDate).format(DATE_FORMAT)
    : moment().format(DATE_FORMAT);

  const queryPeriodRange = `
    SELECT id FROM period WHERE id BETWEEN ? AND ?;
  `;

  const queryPeriodId = periodId
    ? 'SELECT id FROM period WHERE id = ? LIMIT 1;'
    : 'SELECT id FROM period WHERE DATE(?) BETWEEN DATE(start_date) AND DATE(end_date) LIMIT 1;';

  const queryStockConsumption = `
    SELECT IF(i.avg_consumption = 1, ROUND(AVG(s.quantity)), i.avg_consumption) AS quantity,
      BUID(i.uuid) AS uuid, i.text, i.code, BUID(d.uuid) AS depot_uuid,
      d.text AS depot_text
    FROM stock_consumption s
      JOIN inventory i ON i.uuid = s.inventory_uuid
      JOIN depot d ON d.uuid = s.depot_uuid
      JOIN period p ON p.id = s.period_id
    WHERE p.id IN (?)
    GROUP BY i.uuid, d.uuid;
  `;

  const period = await db.one(queryPeriodId, [periodId || baseDate]);
  const beginingPeriod = period.id - numberOfMonths;
  const paramPeriodRange = beginingPeriod > 0 ? [beginingPeriod + 1, period.id] : [1, period.id];

  const rows = await db.exec(queryPeriodRange, paramPeriodRange);
  const ids = rows.map(row => row.id);

  return db.exec(queryStockConsumption, [ids]);
}

/**
 * Inventory Quantity and Consumptions
 */
function getInventoryQuantityAndConsumption(params) {
  let _status;
  let delay;
  let purchaseInterval;
  let requirePurchaseOrder;
  let excludeToken = '';

  if (params.status) {
    _status = params.status;
    delete params.status;
  }

  if (params.inventory_delay) {
    delay = params.inventory_delay;
    delete params.inventory_delay;
  }

  if (params.purchase_interval) {
    purchaseInterval = params.purchase_interval;
    delete params.purchase_interval;
  }

  if (params.require_po) {
    requirePurchaseOrder = params.require_po;
    delete params.require_po;
  }

  if (Number(params.includeEmptyLot) === 0) {
    excludeToken = 'HAVING quantity > 0';
    delete params.includeEmptyLot;
  }

  const sql = `
    SELECT BUID(l.uuid) AS uuid, l.label, l.initial_quantity,
      SUM(m.quantity * IF(m.is_exit = 1, -1, 1)) AS quantity,
      d.text AS depot_text, l.unit_cost, l.expiration_date,
      ROUND(DATEDIFF(l.expiration_date, CURRENT_DATE()) / 30.5) AS lifetime,
      BUID(l.inventory_uuid) AS inventory_uuid, BUID(l.origin_uuid) AS origin_uuid,
      l.entry_date, BUID(i.uuid) AS inventory_uuid, i.code, i.text, BUID(m.depot_uuid) AS depot_uuid,
      i.avg_consumption, i.purchase_interval, i.delay,
      iu.text AS unit_type,
      BUID(ig.uuid) AS group_uuid, ig.name AS group_name,
      dm.text AS documentReference
    FROM stock_movement m
    JOIN lot l ON l.uuid = m.lot_uuid
    JOIN inventory i ON i.uuid = l.inventory_uuid
    JOIN inventory_unit iu ON iu.id = i.unit_id
    JOIN inventory_group ig ON ig.uuid = i.group_uuid
    JOIN depot d ON d.uuid = m.depot_uuid
    LEFT JOIN document_map dm ON dm.uuid = m.document_uuid
  `;

  const clause = ` GROUP BY l.inventory_uuid, m.depot_uuid ${excludeToken} ORDER BY ig.name, i.text `;

  return getLots(sql, params, clause)
    .then(inventories => processStockConsumptionAverage(inventories, params.dateTo))
    .then(inventories => stockManagementProcess(inventories, delay, purchaseInterval))
    .then(rows => {
      let filteredRows = rows;

      if (_status) {
        filteredRows = filteredRows.filter(row => row.status === _status);
      }

      if (requirePurchaseOrder) {
        filteredRows = filteredRows.filter(row => row.S_Q > 0);
      }

      return filteredRows;
    });
}

/**
 * process multiple stock lots
 *
 * @description
 * the goals of this function is to give the risk of peremption for each lots for
 * a given inventory
 */
function processMultipleLots(inventories) {
  const flattenLots = [];
  const inventoryByDepots = _.groupBy(inventories, 'depot_uuid');

  _.map(inventoryByDepots, (depotInventories) => {

    const inventoryLots = _.groupBy(depotInventories, 'inventory_uuid');

    _.map(inventoryLots, (lots) => {
      // if we don't have the default CMM (avg_consumption) use the
      // defined or computed CMM for each lots
      const cmm = _.max(lots.map(lot => lot.avg_consumption));

      // order lots also by ascending quantity
      // assuming the lot with lowest quantity is consumed first
      let orderedInventoryLots = _.orderBy(lots, 'quantity', 'asc');

      // order lots by ascending lifetime has a hight priority than quantity
      orderedInventoryLots = _.orderBy(orderedInventoryLots, 'lifetime', 'asc');

      // compute the lot coefficient
      let lotLifetime = 0;
      _.each(orderedInventoryLots, lot => {
        // apply the same CMM to all lots and update monthly consumption
        lot.avg_consumption = cmm;
        lot.S_MONTH = cmm ? Math.floor(lot.quantity / cmm) : lot.quantity;

        const zeroMSD = Math.round(lot.S_MONTH) === 0;

        lot.S_LOT_LIFETIME = zeroMSD || lot.lifetime < 0 ? 0 : lot.lifetime - lotLifetime;
        lot.S_RISK = zeroMSD ? 0 : lot.S_LOT_LIFETIME - lot.S_MONTH;
        lot.S_RISK_QUANTITY = Math.round(lot.S_RISK * lot.avg_consumption);
        lotLifetime += lot.S_LOT_LIFETIME;

        flattenLots.push(lot);
      });
    });

  });

  return flattenLots;
}

/**
 * @function processStockConsumptionAverage
 *
 * @description
 * This function reads the average stock consumption for each inventory item
 * in a depot.
 */
async function processStockConsumptionAverage(inventories, dateTo) {
  const consumptions = await getStockConsumptionAverage(null, dateTo);

  for (let i = 0; i < consumptions.length; i++) {
    for (let j = 0; j < inventories.length; j++) {
      const isSameInventory = consumptions[i].uuid === inventories[j].inventory_uuid;
      const isSameDepot = consumptions[i].depot_uuid === inventories[j].depot_uuid;
      if (isSameInventory && isSameDepot) {
        inventories[j].avg_consumption = consumptions[i].quantity;
        break;
      }
    }
  }

  return inventories;
}

/**
 * Inventory Movement Report
 */
function getInventoryMovements(params) {
  const bundle = {};

  const sql = `
    SELECT BUID(l.uuid) AS uuid, l.label, l.initial_quantity,
      d.text AS depot_text, l.unit_cost, l.expiration_date,
      m.quantity, m.is_exit, m.date,
      BUID(l.inventory_uuid) AS inventory_uuid, BUID(l.origin_uuid) AS origin_uuid,
      l.entry_date, i.code, i.text, BUID(m.depot_uuid) AS depot_uuid,
      i.avg_consumption, i.purchase_interval, i.delay, iu.text AS unit_type,
      dm.text AS documentReference
    FROM stock_movement m
    JOIN lot l ON l.uuid = m.lot_uuid
    JOIN inventory i ON i.uuid = l.inventory_uuid
    JOIN inventory_unit iu ON iu.id = i.unit_id
    JOIN depot d ON d.uuid = m.depot_uuid
    LEFT JOIN document_map dm ON dm.uuid = m.document_uuid
  `;

  const orderBy = params.orderByCreatedAt ? 'm.created_at' : 'm.date';

  return getLots(sql, params, ` ORDER BY ${orderBy} ASC `)
    .then((rows) => {
      bundle.movements = rows;

      // build the inventory report
      let stockQuantity = 0;
      let stockUnitCost = 0;
      let stockValue = 0;

      // stock method CUMP : cout unitaire moyen pondere
      const movements = bundle.movements.map(line => {
        const movement = {
          reference : line.documentReference,
          date : line.date,
          entry : { quantity : 0, unit_cost : 0, value : 0 },
          exit : { quantity : 0, unit_cost : 0, value : 0 },
          stock : { quantity : 0, unit_cost : 0, value : 0 },
        };

        if (line.is_exit) {
          stockQuantity -= line.quantity;
          stockValue = stockQuantity * stockUnitCost;
          // fix negative value disorder
          // ignoring negative stock value by setting them to zero for entry
          stockValue = (stockValue < 0) ? 0 : stockValue;

          // exit
          movement.exit.quantity = line.quantity;
          movement.exit.unit_cost = stockUnitCost;
          movement.exit.value = line.quantity * line.unit_cost;
        } else {
          const newQuantity = line.quantity + stockQuantity;
          // fix negative value disorder
          // ignoring negative stock value by setting them to movement value for exit
          const newValue = (stockValue < 0)
            ? (line.unit_cost * line.quantity)
            : (line.unit_cost * line.quantity) + stockValue;
          // don't use cumulated quantity when stock quantity < 0
          // in this case use movement quantity only
          const newCost = newValue / (stockQuantity < 0 ? line.quantity : newQuantity);

          stockQuantity = newQuantity;
          stockUnitCost = newCost;
          stockValue = newValue;

          // entry
          movement.entry.quantity = line.quantity;
          movement.entry.unit_cost = line.unit_cost;
          movement.entry.value = line.quantity * line.unit_cost;
        }

        // stock status
        movement.stock.quantity = stockQuantity;
        movement.stock.unit_cost = stockUnitCost;
        movement.stock.value = stockValue;

        return movement;
      });

      // totals of quantities
      const totals = movements.reduce((total, line) => {
        total.entry += line.entry.quantity;
        total.exit += line.exit.quantity;
        return total;
      }, { entry : 0, exit : 0 });

      // stock value
      const result = movements.length ? movements[movements.length - 1] : {};

      return { movements, totals, result };
    });
}
