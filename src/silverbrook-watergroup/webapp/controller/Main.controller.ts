import Controller from "sap/ui/core/mvc/Controller";
import JSONModel from "sap/ui/model/json/JSONModel";
import type { ListBase$UpdateFinishedEvent } from "sap/m/ListBase";

/**
 * The Silverbrook Springs page. Every table is bound straight to the OData services in
 * Main.view.xml, so this controller only keeps a small "view" model with UI state.
 *
 * @namespace silverbrook.watergroup.controller
 */
export default class Main extends Controller {
  public onInit(): void {
    const viewModel = new JSONModel({
      // Resolved through the module system so the image also loads inside the launchpad.
      mapUrl: sap.ui.require.toUrl("silverbrook/watergroup/img/oakhaven-map.jpg"),
      counts: {},
    });
    this.getView()?.setModel(viewModel, "view");
  }

  /** Shows the number of rows of a table as the count on its tab. */
  public onTableUpdateFinished(event: ListBase$UpdateFinishedEvent): void {
    const view = this.getView();
    const table = event.getSource();
    if (!view || !table) return;
    const viewModel = view.getModel("view") as JSONModel;
    viewModel.setProperty(`/counts/${view.getLocalId(table.getId())}`, event.getParameter("total"));
  }
}
