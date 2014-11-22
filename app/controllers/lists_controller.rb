class ListsController < ApplicationController
  def show
    @list = List.find(params[:id])
    @gift = Gift.new
    @action = "create"
  end
  
  def new
    @list = List.new
  end
  
  def update
    list = List.find(params[:id])
    list.update_attributes(list_params)
  end
  
  def create
    list = List.create(list_params)
    redirect_to action: "show", id: list.list_id
  end
  
  private

  def list_params
    params.require(:list).permit(:name)
  end
end