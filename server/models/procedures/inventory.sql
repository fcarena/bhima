DELIMITER $$
/*
  ---------------------------------------------------
  Import Inventory Procedure
  ---------------------------------------------------

  This procedure import a new inventory into the system
  by creating one and performing a stock integration
  if necessary.
*/
DROP PROCEDURE IF EXISTS ImportInventory;
CREATE PROCEDURE ImportInventory (
  IN enterpriseId SMALLINT(5),
  IN inventoryGroupName VARCHAR(100),
  IN inventoryCode VARCHAR(30),
  IN inventoryText VARCHAR(100),
  IN inventoryType VARCHAR(30),
  IN inventoryUnit VARCHAR(30),
  IN inventoryUnitPrice DECIMAL(10, 4)
)
BEGIN
  DECLARE existInventoryGroup TINYINT(1);
  DECLARE existInventoryType TINYINT(1);
  DECLARE existInventoryUnit TINYINT(1);
  DECLARE existInventory TINYINT(1);

  DECLARE randomCode INT(11);
  DECLARE inventoryGroupUuid BINARY(16);
  DECLARE inventoryTypeId TINYINT(3);
  DECLARE inventoryUnitId SMALLINT(5);

  SET existInventoryGroup = (SELECT IF((SELECT COUNT(`name`) AS total FROM `inventory_group` WHERE `name` = inventoryGroupName) > 0, 1, 0));
  SET existInventory = (SELECT IF((SELECT COUNT(`text`) AS total FROM `inventory` WHERE `code` = inventoryCode OR `text` = inventoryText) > 0, 1, 0));
  SET existInventoryType = (SELECT IF((SELECT COUNT(*) AS total FROM `inventory_type` WHERE `text` = inventoryType) > 0, 1, 0));
  SET existInventoryUnit = (SELECT IF((SELECT COUNT(*) AS total FROM `inventory_unit` WHERE `text` = inventoryUnit) > 0, 1, 0));

  /* Create group if doesn't exist */
  IF (existInventoryGroup = 0) THEN
    SET randomCode = (SELECT ROUND(RAND() * 10000000));
    SET inventoryGroupUuid = HUID(UUID());
    INSERT INTO `inventory_group` (`uuid`, `name`, `code`) VALUES (inventoryGroupUuid, inventoryGroupName, randomCode);
  ELSE
    SET inventoryGroupUuid = (SELECT `uuid` FROM `inventory_group` WHERE `name` = inventoryGroupName LIMIT 1);
  END IF;

  /* Create type if doesn't exist */
  IF (existInventoryType = 0) THEN
    SET inventoryTypeId = (SELECT MAX(`id`) + 1 FROM `inventory_type`);
    INSERT INTO `inventory_type` (`id`, `text`) VALUES (inventoryTypeId, inventoryType);
  ELSE
    SET inventoryTypeId = (SELECT `id` FROM `inventory_type` WHERE LOWER(`text`) = LOWER(inventoryType) LIMIT 1);
  END IF;

  /* Create unit if doesn't exist */
  IF (existInventoryUnit = 0) THEN
    SET inventoryUnitId = (SELECT MAX(`id`) + 1 FROM `inventory_unit`);
    INSERT INTO `inventory_unit` (`id`, `abbr`, `text`) VALUES (inventoryUnitId, inventoryUnit, inventoryUnit);
  ELSE
    SET inventoryUnitId = (SELECT `id` FROM `inventory_unit` WHERE LOWER(`text`) = LOWER(inventoryUnit) LIMIT 1);
  END IF;

  /*
    Create inventory if it doesn't exist

    If the inventory already exists, skip because we are in a loop and
    we have to continue importing other inventories

    Inventory imported are considered by default as stockable (consumbale)
  */
  IF (existInventory = 0) THEN
    INSERT INTO `inventory` (`enterprise_id`, `uuid`, `code`, `text`, `price`, `group_uuid`, `type_id`, `unit_id`, `consumable`)
    VALUES
    (enterpriseId, HUID(UUID()), inventoryCode, inventoryText, inventoryUnitPrice, inventoryGroupUuid, inventoryTypeId, inventoryUnitId, 1);
  END IF;
END $$

DROP PROCEDURE IF EXISTS importPriceListItem;
CREATE PROCEDURE importPriceListItem (
  IN _price_list_uuid BINARY(16),
  IN _inventory_code VARCHAR(30),
  IN _value DOUBLE,
  IN _is_percentage tinyint(1)
)
BEGIN
  DECLARE _inventory_uuid BINARY(16);
  DECLARE isInventory tinyint(5);
   DECLARE inventoryLabel VARCHAR(100);

  SELECT uuid, text,  count(uuid)
  INTO _inventory_uuid, inventoryLabel, isInventory
  FROM inventory
  WHERE code = _inventory_code;

  IF isInventory = 1 THEN
    DELETE FROM price_list_item
      WHERE price_list_uuid = _price_list_uuid AND inventory_uuid = _inventory_uuid;
    INSERT INTO price_list_item(uuid, inventory_uuid, price_list_uuid, label, value, is_percentage)
    VALUES(HUID(uuid()), _inventory_uuid, _price_list_uuid, inventoryLabel, _value, _is_percentage);
  END IF;

END $$

DELIMITER ;
