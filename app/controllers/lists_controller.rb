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
    user = User.new
    user.save!
    list.update_attribute(:user, user.id)
    session[:user_id] = user.id
    redirect_to action: "show", id: list.id
  end
  
  private

  def list_params
    params.require(:list).permit(:name)
  end
end