/* eslint-disable no-console */
/**
 * 种子数据：发布示例因子库、两套 GWP，并导入若干活动数据。
 * 用法：npm run seed（默认内存驱动无意义，通常配合 DB_DRIVER=pg）
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { FactorService } from '../src/factors/factor.service';
import { ActivityService } from '../src/activity/activity.service';
import { FactorRowType, Scope } from '../src/factors/entities';
import { FactorVersionDraft } from '../src/factors/store.interface';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  const factors = app.get(FactorService);
  const activity = app.get(ActivityService);

  const fv: FactorVersionDraft = {
    id: 'fv-seed-2024',
    label: '种子因子库 2024',
    effectiveStart: '2024-01',
    effectiveEnd: null,
    rows: [
      { fuelOrActivity: 'natural_gas', type: FactorRowType.EMISSION, gas: 'CO2', scope: Scope.SCOPE_1, value: '56.1', unit: 'kg/GJ' },
      { fuelOrActivity: 'natural_gas', type: FactorRowType.EMISSION, gas: 'CH4', scope: Scope.SCOPE_1, value: '0.001', unit: 'kg/GJ' },
      { fuelOrActivity: 'natural_gas', type: FactorRowType.EMISSION, gas: 'N2O', scope: Scope.SCOPE_1, value: '0.0001', unit: 'kg/GJ' },
      { fuelOrActivity: 'diesel', type: FactorRowType.EMISSION, gas: 'CO2', scope: Scope.SCOPE_1, value: '2.68', unit: 'kg/L' },
      { fuelOrActivity: 'diesel', type: FactorRowType.EMISSION, gas: 'CH4', scope: Scope.SCOPE_1, value: '0.0001', unit: 'kg/L' },
      { fuelOrActivity: 'diesel', type: FactorRowType.EMISSION, gas: 'N2O', scope: Scope.SCOPE_1, value: '0.00002', unit: 'kg/L' },
      { fuelOrActivity: 'grid_electricity', type: FactorRowType.EMISSION, gas: 'CO2', scope: Scope.SCOPE_2, value: '0.5', unit: 'kg/kWh' },
      { fuelOrActivity: 'grid_electricity', type: FactorRowType.EMISSION, gas: 'CH4', scope: Scope.SCOPE_2, value: '0', unit: 'kg/kWh' },
      { fuelOrActivity: 'grid_electricity', type: FactorRowType.EMISSION, gas: 'N2O', scope: Scope.SCOPE_2, value: '0', unit: 'kg/kWh' },
    ],
  };
  console.log(await factors.publishFactorVersion(fv));
  console.log(
    await factors.publishGwpSet({
      id: 'ar5',
      label: 'IPCC AR5 (100yr)',
      values: [
        { gas: 'CO2', value: '1' },
        { gas: 'CH4', value: '28' },
        { gas: 'N2O', value: '265' },
      ],
    }),
  );
  console.log(
    await factors.publishGwpSet({
      id: 'ar6',
      label: 'IPCC AR6 (100yr)',
      values: [
        { gas: 'CO2', value: '1' },
        { gas: 'CH4', value: '29.8' },
        { gas: 'N2O', value: '273' },
      ],
    }),
  );

  const report = await activity.importBatch([
    { id: 'seed-1', plantId: 'P-NORTH', sourceId: 'BOILER-1', fuelOrActivity: 'natural_gas', month: '2024-01', quantity: 100, unit: 'GJ' },
    { id: 'seed-2', plantId: 'P-NORTH', sourceId: 'FLEET-1', fuelOrActivity: 'diesel', month: '2024-01', quantity: 1000, unit: 'L' },
    { id: 'seed-3', plantId: 'P-SOUTH', sourceId: 'GRID-1', fuelOrActivity: 'grid_electricity', month: '2024-01', quantity: 5000, unit: 'kWh' },
  ]);
  console.log(JSON.stringify(report, null, 2));

  await app.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
